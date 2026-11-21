// Package kube talks to the Kubernetes API server on behalf of the signed-in
// user. Every call carries the user's bearer token; the dashboard has no
// credentials of its own.
package kube

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	authenticationv1 "k8s.io/api/authentication/v1"
	authorizationv1 "k8s.io/api/authorization/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/util/retry"
)

// GPUNodes is the resource of the GPUNode custom resources.
var GPUNodes = schema.GroupVersionResource{Group: "kybernate.io", Version: "v1alpha1", Resource: "gpunodes"}

// GPUWorkloads is the resource of the GPUWorkload custom resources.
var GPUWorkloads = schema.GroupVersionResource{Group: "kybernate.io", Version: "v1alpha1", Resource: "gpuworkloads"}

// ErrInvalidState is returned for a workload state other than Running or
// Suspended.
var ErrInvalidState = errors.New("the state must be Running or Suspended")

// Errors returned by the client. Other errors come from the API server.
var (
	ErrUnauthorized = errors.New("the API server does not accept the token")
	ErrForbidden    = errors.New("the user is not allowed to do this")
	ErrNotFound     = errors.New("not found")
	ErrNotInstalled = errors.New("the GPUNode resource is not installed, install Kybernate first")
	ErrUnknownGPU   = errors.New("the GPU does not belong to the node")
)

// Client creates API clients for user tokens.
type Client struct {
	base      *rest.Config
	userAgent string

	// Overridable in tests.
	dynamicFor func(token string) (dynamic.Interface, error)
	typedFor   func(token string) (kubernetes.Interface, error)
}

// New returns a client for the API server described by base. Only the address
// and the TLS settings of base are used; its credentials are dropped.
func New(base *rest.Config, userAgent string) *Client {
	c := &Client{base: rest.AnonymousClientConfig(base), userAgent: userAgent}
	c.dynamicFor = func(token string) (dynamic.Interface, error) { return dynamic.NewForConfig(c.config(token)) }
	c.typedFor = func(token string) (kubernetes.Interface, error) { return kubernetes.NewForConfig(c.config(token)) }
	return c
}

func (c *Client) config(token string) *rest.Config {
	cfg := rest.CopyConfig(c.base)
	cfg.BearerToken = token
	cfg.UserAgent = c.userAgent
	return cfg
}

// WhoAmI returns the user the token belongs to. It fails with ErrUnauthorized
// for a token the API server does not accept.
func (c *Client) WhoAmI(ctx context.Context, token string) (User, error) {
	cs, err := c.typedFor(token)
	if err != nil {
		return User{}, err
	}
	review, err := cs.AuthenticationV1().SelfSubjectReviews().Create(ctx, &authenticationv1.SelfSubjectReview{}, metav1.CreateOptions{})
	if err != nil {
		return User{}, mapError(err)
	}
	info := review.Status.UserInfo
	return User{Username: info.Username, Groups: info.Groups}, nil
}

// Access checks whether the user may list GPUNodes and change reservations.
func (c *Client) Access(ctx context.Context, token string) (Access, error) {
	cs, err := c.typedFor(token)
	if err != nil {
		return Access{}, err
	}
	allowed := func(verb string, resources ...string) (bool, error) {
		resource := GPUNodes.Resource
		if len(resources) > 0 {
			resource = resources[0]
		}
		review, err := cs.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, &authorizationv1.SelfSubjectAccessReview{
			Spec: authorizationv1.SelfSubjectAccessReviewSpec{
				ResourceAttributes: &authorizationv1.ResourceAttributes{Group: GPUNodes.Group, Resource: resource, Verb: verb},
			},
		}, metav1.CreateOptions{})
		if err != nil {
			return false, mapError(err)
		}
		return review.Status.Allowed, nil
	}
	var access Access
	if access.List, err = allowed("list"); err != nil {
		return Access{}, err
	}
	if access.Reserve, err = allowed("update"); err != nil {
		return Access{}, err
	}
	if access.Suspend, err = allowed("patch", GPUWorkloads.Resource); err != nil {
		return Access{}, err
	}
	return access, nil
}

// ListGPUNodes returns all GPUNodes, sorted by name.
func (c *Client) ListGPUNodes(ctx context.Context, token string) ([]GPUNode, error) {
	dyn, err := c.dynamicFor(token)
	if err != nil {
		return nil, err
	}
	list, err := dyn.Resource(GPUNodes).List(ctx, metav1.ListOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return nil, ErrNotInstalled
		}
		return nil, mapError(err)
	}
	out := make([]GPUNode, 0, len(list.Items))
	for i := range list.Items {
		node, err := decode(&list.Items[i])
		if err != nil {
			return nil, err
		}
		out = append(out, node)
	}
	slices.SortFunc(out, func(a, b GPUNode) int { return strings.Compare(a.Name, b.Name) })
	return out, nil
}

// WatchGPUNodes watches all GPUNodes. The caller stops the watch.
func (c *Client) WatchGPUNodes(ctx context.Context, token string) (watch.Interface, error) {
	dyn, err := c.dynamicFor(token)
	if err != nil {
		return nil, err
	}
	w, err := dyn.Resource(GPUNodes).Watch(ctx, metav1.ListOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return nil, ErrNotInstalled
		}
		return nil, mapError(err)
	}
	return w, nil
}

// ListGPUWorkloads returns all GPUWorkloads the user may see, sorted by
// namespace and name. Without the CRD, or without access, the list is empty.
func (c *Client) ListGPUWorkloads(ctx context.Context, token string) ([]GPUWorkload, error) {
	dyn, err := c.dynamicFor(token)
	if err != nil {
		return nil, err
	}
	list, err := dyn.Resource(GPUWorkloads).List(ctx, metav1.ListOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) || apierrors.IsForbidden(err) {
			return []GPUWorkload{}, nil
		}
		return nil, mapError(err)
	}
	out := make([]GPUWorkload, 0, len(list.Items))
	for i := range list.Items {
		raw, err := json.Marshal(list.Items[i].Object)
		if err != nil {
			return nil, err
		}
		var v struct {
			Spec   GPUWorkloadSpec   `json:"spec"`
			Status GPUWorkloadStatus `json:"status"`
		}
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, fmt.Errorf("decoding GPUWorkload %s: %w", list.Items[i].GetName(), err)
		}
		out = append(out, GPUWorkload{Namespace: list.Items[i].GetNamespace(), Name: list.Items[i].GetName(), Spec: v.Spec, Status: v.Status})
	}
	slices.SortFunc(out, func(a, b GPUWorkload) int {
		if c := strings.Compare(a.Namespace, b.Namespace); c != 0 {
			return c
		}
		return strings.Compare(a.Name, b.Name)
	})
	return out, nil
}

// WatchGPUWorkloads watches all GPUWorkloads.
func (c *Client) WatchGPUWorkloads(ctx context.Context, token string) (watch.Interface, error) {
	dyn, err := c.dynamicFor(token)
	if err != nil {
		return nil, err
	}
	w, err := dyn.Resource(GPUWorkloads).Watch(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, mapError(err)
	}
	return w, nil
}

// SetWorkloadState suspends or resumes a workload through spec.state.
func (c *Client) SetWorkloadState(ctx context.Context, token, namespace, name, state string) error {
	if state != "Running" && state != "Suspended" {
		return ErrInvalidState
	}
	dyn, err := c.dynamicFor(token)
	if err != nil {
		return err
	}
	patch := []byte(`{"spec":{"state":"` + state + `"}}`)
	if _, err := dyn.Resource(GPUWorkloads).Namespace(namespace).Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{}); err != nil {
		return mapError(err)
	}
	return nil
}

// SetReservation reserves a GPU of a node for Kybernate or releases it, by
// changing spec.reservedGPUs of the node's GPUNode. A GPU that a regular pod
// holds can be reserved as well; the node agent then reports it as
// PendingReservation until the pod has released it.
func (c *Client) SetReservation(ctx context.Context, token, nodeName, uuid string, reserved bool) (GPUNode, error) {
	dyn, err := c.dynamicFor(token)
	if err != nil {
		return GPUNode{}, err
	}
	res := dyn.Resource(GPUNodes)
	var result GPUNode
	err = retry.RetryOnConflict(retry.DefaultRetry, func() error {
		obj, err := res.Get(ctx, nodeName, metav1.GetOptions{})
		if err != nil {
			return err
		}
		node, err := decode(obj)
		if err != nil {
			return err
		}
		if !slices.ContainsFunc(node.Status.GPUs, func(g GPU) bool { return g.UUID == uuid }) {
			return ErrUnknownGPU
		}
		list := slices.DeleteFunc(slices.Clone(node.Spec.ReservedGPUs), func(id string) bool { return id == uuid })
		if reserved {
			list = append(list, uuid)
		}
		if len(list) == 0 {
			unstructured.RemoveNestedField(obj.Object, "spec", "reservedGPUs")
		} else if err := unstructured.SetNestedStringSlice(obj.Object, list, "spec", "reservedGPUs"); err != nil {
			return err
		}
		updated, err := res.Update(ctx, obj, metav1.UpdateOptions{})
		if err != nil {
			return err
		}
		result, err = decode(updated)
		return err
	})
	if err != nil {
		return GPUNode{}, mapError(err)
	}
	return result, nil
}

func decode(obj *unstructured.Unstructured) (GPUNode, error) {
	raw, err := json.Marshal(obj.Object)
	if err != nil {
		return GPUNode{}, err
	}
	var v struct {
		Spec   GPUNodeSpec   `json:"spec"`
		Status GPUNodeStatus `json:"status"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return GPUNode{}, fmt.Errorf("decoding GPUNode %s: %w", obj.GetName(), err)
	}
	return GPUNode{Name: obj.GetName(), Spec: v.Spec, Status: v.Status}, nil
}

func mapError(err error) error {
	switch {
	case errors.Is(err, ErrUnknownGPU), errors.Is(err, ErrInvalidState):
		return err
	case apierrors.IsUnauthorized(err):
		return ErrUnauthorized
	case apierrors.IsForbidden(err):
		return fmt.Errorf("%w: %s", ErrForbidden, err.Error())
	case apierrors.IsNotFound(err):
		return ErrNotFound
	default:
		return err
	}
}
