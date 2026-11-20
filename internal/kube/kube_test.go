package kube

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	authenticationv1 "k8s.io/api/authentication/v1"
	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
)

// apiServer answers SelfSubjectReviews and SelfSubjectAccessReviews for the
// token "good". The user may list GPUNodes but not update them.
func apiServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "Bearer good" {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(metav1.Status{
				TypeMeta: metav1.TypeMeta{Kind: "Status", APIVersion: "v1"},
				Status:   metav1.StatusFailure, Reason: metav1.StatusReasonUnauthorized, Code: http.StatusUnauthorized,
			})
			return
		}
		switch r.URL.Path {
		case "/apis/authentication.k8s.io/v1/selfsubjectreviews":
			_ = json.NewEncoder(w).Encode(authenticationv1.SelfSubjectReview{
				TypeMeta: metav1.TypeMeta{Kind: "SelfSubjectReview", APIVersion: "authentication.k8s.io/v1"},
				Status: authenticationv1.SelfSubjectReviewStatus{UserInfo: authenticationv1.UserInfo{
					Username: "system:serviceaccount:ops:viewer", Groups: []string{"system:authenticated"},
				}},
			})
		case "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews":
			// client-go may send protobuf or JSON.
			raw, _ := io.ReadAll(r.Body)
			obj, _, err := scheme.Codecs.UniversalDeserializer().Decode(raw, nil, nil)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			review := *obj.(*authorizationv1.SelfSubjectAccessReview)
			review.Status.Allowed = review.Spec.ResourceAttributes.Verb == "list"
			review.TypeMeta = metav1.TypeMeta{Kind: "SelfSubjectAccessReview", APIVersion: "authorization.k8s.io/v1"}
			_ = json.NewEncoder(w).Encode(review)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestWhoAmIAndAccess(t *testing.T) {
	srv := apiServer(t)
	// Credentials in the base configuration must not be used.
	c := New(&rest.Config{Host: srv.URL, BearerToken: "dashboard-own-token"}, "test")

	user, err := c.WhoAmI(context.Background(), "good")
	if err != nil {
		t.Fatal(err)
	}
	if user.Username != "system:serviceaccount:ops:viewer" {
		t.Fatalf("user = %+v", user)
	}
	access, err := c.Access(context.Background(), "good")
	if err != nil {
		t.Fatal(err)
	}
	if !access.List || access.Reserve {
		t.Fatalf("access = %+v", access)
	}
	if _, err := c.WhoAmI(context.Background(), "bad"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("bad token: err = %v", err)
	}
}

func gpuNode(name string, reserved []string, uuids ...string) *unstructured.Unstructured {
	gpus := make([]any, 0, len(uuids))
	for i, id := range uuids {
		gpus = append(gpus, map[string]any{"index": int64(i), "uuid": id, "name": "NVIDIA RTX A6000", "state": "Free",
			"allocatedTo": []any{map[string]any{"namespace": "ml", "name": "trainer"}}})
	}
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "kybernate.io/v1alpha1",
		"kind":       "GPUNode",
		"metadata":   map[string]any{"name": name},
		"status":     map[string]any{"gpuCount": int64(len(uuids)), "gpus": gpus, "driverVersion": "615.71.09"},
	}}
	if len(reserved) > 0 {
		list := make([]any, 0, len(reserved))
		for _, r := range reserved {
			list = append(list, r)
		}
		obj.Object["spec"] = map[string]any{"reservedGPUs": list}
	}
	return obj
}

func fakeClient(objects ...runtime.Object) *Client {
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{GPUNodes: "GPUNodeList"}, objects...)
	c := New(&rest.Config{Host: "https://unused"}, "test")
	c.dynamicFor = func(string) (dynamic.Interface, error) { return dyn, nil }
	return c
}

func TestListGPUNodes(t *testing.T) {
	c := fakeClient(gpuNode("node-b", nil, "GPU-b0"), gpuNode("node-a", []string{"GPU-a1"}, "GPU-a0", "GPU-a1"))
	nodes, err := c.ListGPUNodes(context.Background(), "token")
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 2 || nodes[0].Name != "node-a" || nodes[1].Name != "node-b" {
		t.Fatalf("nodes = %+v", nodes)
	}
	a := nodes[0]
	if !slices.Equal(a.Spec.ReservedGPUs, []string{"GPU-a1"}) || len(a.Status.GPUs) != 2 || a.Status.DriverVersion != "615.71.09" {
		t.Fatalf("node-a = %+v", a)
	}
	if got := a.Status.GPUs[1].AllocatedTo; len(got) != 1 || got[0].Name != "trainer" {
		t.Fatalf("allocatedTo = %+v", got)
	}
}

func TestSetReservation(t *testing.T) {
	c := fakeClient(gpuNode("node-a", []string{"GPU-a1"}, "GPU-a0", "GPU-a1"))
	ctx := context.Background()

	node, err := c.SetReservation(ctx, "token", "node-a", "GPU-a0", true)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(node.Spec.ReservedGPUs, []string{"GPU-a1", "GPU-a0"}) {
		t.Fatalf("after reserving: %v", node.Spec.ReservedGPUs)
	}
	// Reserving twice keeps one entry.
	if node, err = c.SetReservation(ctx, "token", "node-a", "GPU-a0", true); err != nil || len(node.Spec.ReservedGPUs) != 2 {
		t.Fatalf("reserving twice: %v %v", node.Spec.ReservedGPUs, err)
	}
	if _, err = c.SetReservation(ctx, "token", "node-a", "GPU-a0", false); err != nil {
		t.Fatal(err)
	}
	if node, err = c.SetReservation(ctx, "token", "node-a", "GPU-a1", false); err != nil {
		t.Fatal(err)
	}
	if len(node.Spec.ReservedGPUs) != 0 {
		t.Fatalf("after releasing all: %v", node.Spec.ReservedGPUs)
	}

	if _, err := c.SetReservation(ctx, "token", "node-a", "GPU-x", true); !errors.Is(err, ErrUnknownGPU) {
		t.Fatalf("unknown GPU: err = %v", err)
	}
	if _, err := c.SetReservation(ctx, "token", "node-x", "GPU-a0", true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown node: err = %v", err)
	}
}
