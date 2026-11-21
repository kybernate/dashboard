// Package server serves the dashboard UI and its JSON API.
//
// Users sign in with a Kubernetes bearer token. The token is kept in an
// HttpOnly cookie and forwarded with every request to the API server, so
// Kubernetes RBAC decides what each user may see and change. The server keeps
// no session state and has no credentials of its own.
package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/watch"

	"github.com/kybernate/dashboard/internal/kube"
)

// Cluster is the part of the Kubernetes API the dashboard uses, always on
// behalf of the user whose token is passed.
type Cluster interface {
	WhoAmI(ctx context.Context, token string) (kube.User, error)
	Access(ctx context.Context, token string) (kube.Access, error)
	ListGPUNodes(ctx context.Context, token string) ([]kube.GPUNode, error)
	WatchGPUNodes(ctx context.Context, token string) (watch.Interface, error)
	ListGPUWorkloads(ctx context.Context, token string) ([]kube.GPUWorkload, error)
	WatchGPUWorkloads(ctx context.Context, token string) (watch.Interface, error)
	SetWorkloadState(ctx context.Context, token, namespace, name, state string) error
	SetReservation(ctx context.Context, token, node, uuid string, reserved bool) (kube.GPUNode, error)
}

const (
	// CookieName is the cookie that holds the user's token.
	CookieName = "kybernate_token"
	// RequestHeader must be set on every request that changes something. A
	// page of another origin cannot set it without a CORS preflight, which
	// the server never allows.
	RequestHeader = "X-Kybernate-Request"
	// maxTokenBytes keeps the cookie below the 4 KiB browsers accept.
	maxTokenBytes = 2800
)

// Server serves the dashboard.
type Server struct {
	Cluster Cluster
	// ClusterName is shown in the header of the dashboard.
	ClusterName string
	// Static holds index.html and the assets of the UI.
	Static  fs.FS
	Version string
	Log     *slog.Logger
}

// Handler returns the HTTP handler of the dashboard.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	mux.HandleFunc("POST /api/login", s.login)
	mux.HandleFunc("POST /api/logout", s.logout)
	mux.HandleFunc("GET /api/session", s.withToken(s.session))
	mux.HandleFunc("GET /api/gpunodes", s.withToken(s.listGPUNodes))
	mux.HandleFunc("GET /api/gpunodes/events", s.withToken(s.gpuNodeEvents))
	mux.HandleFunc("PUT /api/gpunodes/{node}/gpus/{uuid}/reservation", s.withToken(s.setReservation))
	mux.HandleFunc("GET /api/workloads", s.withToken(s.listWorkloads))
	mux.HandleFunc("PUT /api/workloads/{namespace}/{name}/state", s.withToken(s.setWorkloadState))
	unknown := func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusNotFound, errorBody{Error: "unknown API endpoint"})
	}
	for _, method := range []string{"GET", "POST", "PUT", "PATCH", "DELETE"} {
		mux.HandleFunc(method+" /api/", unknown)
	}
	mux.Handle("GET /", http.FileServerFS(s.Static))
	return securityHeaders(sameOrigin(mux))
}

type sessionBody struct {
	User        kube.User   `json:"user"`
	Access      kube.Access `json:"access"`
	ClusterName string      `json:"clusterName,omitempty"`
	Version     string      `json:"version,omitempty"`
}

type errorBody struct {
	Error string `json:"error"`
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "the request is not valid JSON"})
		return
	}
	token := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(req.Token), "Bearer "))
	switch {
	case token == "":
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "enter a token"})
		return
	case len(token) > maxTokenBytes:
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "the token is too long for a browser cookie"})
		return
	}
	body, err := s.sessionFor(r.Context(), token)
	if err != nil {
		s.writeError(w, err)
		return
	}
	http.SetCookie(w, tokenCookie(r, base64.RawURLEncoding.EncodeToString([]byte(token)), 0))
	s.Log.Info("user signed in", "user", body.User.Username)
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, tokenCookie(r, "", -1))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) session(w http.ResponseWriter, r *http.Request, token string) {
	body, err := s.sessionFor(r.Context(), token)
	if err != nil {
		if errors.Is(err, kube.ErrUnauthorized) {
			http.SetCookie(w, tokenCookie(r, "", -1))
		}
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) sessionFor(ctx context.Context, token string) (sessionBody, error) {
	user, err := s.Cluster.WhoAmI(ctx, token)
	if err != nil {
		return sessionBody{}, err
	}
	access, err := s.Cluster.Access(ctx, token)
	if err != nil {
		return sessionBody{}, err
	}
	return sessionBody{User: user, Access: access, ClusterName: s.ClusterName, Version: s.Version}, nil
}

func (s *Server) listGPUNodes(w http.ResponseWriter, r *http.Request, token string) {
	nodes, err := s.Cluster.ListGPUNodes(r.Context(), token)
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": nodes})
}

// Timing of the event stream. Variables so that tests can shorten them.
var (
	eventDebounce     = 250 * time.Millisecond
	eventKeepAlive    = 25 * time.Second
	eventWatchRestart = time.Second
)

// gpuNodeEvents streams the GPUNodes and the GPUWorkloads as server-sent
// events: once at the start and again after every change of either,
// debounced. The watches run with the user's token, so RBAC applies as for
// every other request. When the token expires, the stream ends and the
// browser's reconnect fails with 401.
func (s *Server) gpuNodeEvents(w http.ResponseWriter, r *http.Request, token string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, errorBody{Error: "streaming is not supported"})
		return
	}
	ctx := r.Context()
	snapshot, err := s.snapshot(ctx, token)
	if err != nil {
		s.writeError(w, err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	send := func(payload map[string]any) bool {
		raw, err := json.Marshal(payload)
		if err != nil {
			return false
		}
		if _, err := fmt.Fprintf(w, "event: gpunodes\ndata: %s\n\n", raw); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !send(snapshot) {
		return
	}

	keepAlive := time.NewTicker(eventKeepAlive)
	defer keepAlive.Stop()
	for ctx.Err() == nil {
		watchers, err := s.watchAll(ctx, token)
		if err != nil {
			s.Log.Warn("watching GPUNodes failed", "error", err)
			return
		}
		cont := s.streamChanges(ctx, watchers, keepAlive.C, w, flusher, token, send)
		for _, wt := range watchers {
			wt.Stop()
		}
		if !cont {
			return
		}
		select {
		case <-ctx.Done():
		case <-time.After(eventWatchRestart):
		}
	}
}

// snapshot reads the GPUNodes and the GPUWorkloads.
func (s *Server) snapshot(ctx context.Context, token string) (map[string]any, error) {
	nodes, err := s.Cluster.ListGPUNodes(ctx, token)
	if err != nil {
		return nil, err
	}
	workloads, err := s.Cluster.ListGPUWorkloads(ctx, token)
	if err != nil {
		return nil, err
	}
	return map[string]any{"items": nodes, "workloads": workloads}, nil
}

// watchAll watches the GPUNodes and, if the user may, the GPUWorkloads.
func (s *Server) watchAll(ctx context.Context, token string) ([]watch.Interface, error) {
	nodes, err := s.Cluster.WatchGPUNodes(ctx, token)
	if err != nil {
		return nil, err
	}
	out := []watch.Interface{nodes}
	if wl, err := s.Cluster.WatchGPUWorkloads(ctx, token); err == nil {
		out = append(out, wl)
	}
	return out, nil
}

// streamChanges sends a snapshot after changes until a watch ends. It
// returns false if the client is gone or the lists cannot be read.
func (s *Server) streamChanges(ctx context.Context, watchers []watch.Interface, keepAlive <-chan time.Time, w http.ResponseWriter, flusher http.Flusher, token string, send func(map[string]any) bool) bool {
	changed := make(chan struct{}, 1)
	ended := make(chan struct{}, len(watchers))
	for _, wt := range watchers {
		go func(wt watch.Interface) {
			for range wt.ResultChan() {
				select {
				case changed <- struct{}{}:
				default:
				}
			}
			ended <- struct{}{}
		}(wt)
	}
	var debounce <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return false
		case <-ended:
			return true
		case <-keepAlive:
			if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
				return false
			}
			flusher.Flush()
		case <-changed:
			if debounce == nil {
				debounce = time.After(eventDebounce)
			}
		case <-debounce:
			debounce = nil
			snapshot, err := s.snapshot(ctx, token)
			if err != nil {
				s.Log.Warn("reading the state for the event stream failed", "error", err)
				return false
			}
			if !send(snapshot) {
				return false
			}
		}
	}
}

func (s *Server) listWorkloads(w http.ResponseWriter, r *http.Request, token string) {
	workloads, err := s.Cluster.ListGPUWorkloads(r.Context(), token)
	if err != nil {
		s.writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": workloads})
}

func (s *Server) setWorkloadState(w http.ResponseWriter, r *http.Request, token string) {
	var req struct {
		State string `json:"state"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: `the body must be {"state": "Running"|"Suspended"}`})
		return
	}
	ns, name := r.PathValue("namespace"), r.PathValue("name")
	if err := s.Cluster.SetWorkloadState(r.Context(), token, ns, name, req.State); err != nil {
		s.writeError(w, err)
		return
	}
	s.Log.Info("workload state changed", "workload", ns+"/"+name, "state", req.State)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) setReservation(w http.ResponseWriter, r *http.Request, token string) {
	var req struct {
		Reserved *bool `json:"reserved"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil || req.Reserved == nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: `the body must be {"reserved": true|false}`})
		return
	}
	node, uuid := r.PathValue("node"), r.PathValue("uuid")
	updated, err := s.Cluster.SetReservation(r.Context(), token, node, uuid, *req.Reserved)
	if err != nil {
		s.writeError(w, err)
		return
	}
	s.Log.Info("reservation changed", "node", node, "gpu", uuid, "reserved", *req.Reserved)
	writeJSON(w, http.StatusOK, updated)
}

// withToken passes the token from the cookie to h, or answers 401.
func (s *Server) withToken(h func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(CookieName)
		if err != nil || cookie.Value == "" {
			writeJSON(w, http.StatusUnauthorized, errorBody{Error: "not signed in"})
			return
		}
		token, err := base64.RawURLEncoding.DecodeString(cookie.Value)
		if err != nil || len(token) == 0 {
			http.SetCookie(w, tokenCookie(r, "", -1))
			writeJSON(w, http.StatusUnauthorized, errorBody{Error: "not signed in"})
			return
		}
		h(w, r, string(token))
	}
}

func (s *Server) writeError(w http.ResponseWriter, err error) {
	status := http.StatusBadGateway
	msg := err.Error()
	switch {
	case errors.Is(err, kube.ErrUnauthorized):
		status, msg = http.StatusUnauthorized, "the Kubernetes API server does not accept this token, or it has expired"
	case errors.Is(err, kube.ErrForbidden):
		status = http.StatusForbidden
	case errors.Is(err, kube.ErrNotInstalled), errors.Is(err, kube.ErrNotFound):
		status = http.StatusNotFound
	case errors.Is(err, kube.ErrUnknownGPU), errors.Is(err, kube.ErrInvalidState):
		status = http.StatusBadRequest
	default:
		s.Log.Warn("request to the Kubernetes API failed", "error", err)
		msg = "the Kubernetes API server could not be reached or failed: " + msg
	}
	writeJSON(w, status, errorBody{Error: msg})
}

func tokenCookie(r *http.Request, value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     CookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
		SameSite: http.SameSiteStrictMode,
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// sameOrigin rejects requests that change something unless they carry
// RequestHeader and, if the browser sends an Origin, come from this host.
func sameOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead:
		default:
			if r.Header.Get(RequestHeader) != "1" {
				writeJSON(w, http.StatusForbidden, errorBody{Error: "missing header " + RequestHeader})
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				if err != nil || u.Host != r.Host {
					writeJSON(w, http.StatusForbidden, errorBody{Error: "cross-origin request rejected"})
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		} else {
			h.Set("Cache-Control", "no-cache")
		}
		next.ServeHTTP(w, r)
	})
}
