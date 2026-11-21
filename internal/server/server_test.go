package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"k8s.io/apimachinery/pkg/watch"

	"github.com/kybernate/dashboard/internal/kube"
)

// fakeCluster accepts the token "good" for an editor and "viewer" for a
// user who may only read.
type fakeCluster struct {
	mu          sync.Mutex
	watcher     *watch.FakeWatcher
	wlWatcher   *watch.FakeWatcher
	state       string
	nodes       []kube.GPUNode
	tokens      []string
	reservation struct {
		node, uuid string
		reserved   bool
	}
}

func (f *fakeCluster) check(token string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tokens = append(f.tokens, token)
	if token != "good" && token != "viewer" {
		return kube.ErrUnauthorized
	}
	return nil
}

func (f *fakeCluster) WhoAmI(_ context.Context, token string) (kube.User, error) {
	if err := f.check(token); err != nil {
		return kube.User{}, err
	}
	return kube.User{Username: "alice"}, nil
}

func (f *fakeCluster) Access(_ context.Context, token string) (kube.Access, error) {
	if err := f.check(token); err != nil {
		return kube.Access{}, err
	}
	return kube.Access{List: true, Reserve: token == "good"}, nil
}

func (f *fakeCluster) ListGPUNodes(_ context.Context, token string) ([]kube.GPUNode, error) {
	if err := f.check(token); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.nodes != nil {
		return f.nodes, nil
	}
	return []kube.GPUNode{{Name: "gpu-01"}}, nil
}

func (f *fakeCluster) WatchGPUNodes(_ context.Context, token string) (watch.Interface, error) {
	if err := f.check(token); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.watcher == nil {
		f.watcher = watch.NewFake()
	}
	return f.watcher, nil
}

func (f *fakeCluster) ListGPUWorkloads(_ context.Context, token string) ([]kube.GPUWorkload, error) {
	if err := f.check(token); err != nil {
		return nil, err
	}
	return []kube.GPUWorkload{{Namespace: "ml", Name: "model", Spec: kube.GPUWorkloadSpec{State: f.state}}}, nil
}

func (f *fakeCluster) WatchGPUWorkloads(_ context.Context, token string) (watch.Interface, error) {
	if err := f.check(token); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.wlWatcher == nil {
		f.wlWatcher = watch.NewFake()
	}
	return f.wlWatcher, nil
}

func (f *fakeCluster) SetWorkloadState(_ context.Context, token, namespace, name, state string) error {
	if err := f.check(token); err != nil {
		return err
	}
	if token == "viewer" {
		return kube.ErrForbidden
	}
	if state != "Running" && state != "Suspended" {
		return kube.ErrInvalidState
	}
	f.mu.Lock()
	f.state = state
	f.mu.Unlock()
	return nil
}

func (f *fakeCluster) SetReservation(_ context.Context, token, node, uuid string, reserved bool) (kube.GPUNode, error) {
	if err := f.check(token); err != nil {
		return kube.GPUNode{}, err
	}
	if token == "viewer" {
		return kube.GPUNode{}, kube.ErrForbidden
	}
	f.reservation.node, f.reservation.uuid, f.reservation.reserved = node, uuid, reserved
	return kube.GPUNode{Name: node, Spec: kube.GPUNodeSpec{ReservedGPUs: []string{uuid}}}, nil
}

func newServer(cluster Cluster) http.Handler {
	s := &Server{
		Cluster:     cluster,
		ClusterName: "lab",
		Static:      fstest.MapFS{"index.html": {Data: []byte("<!doctype html>")}},
		Log:         slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	return s.Handler()
}

func do(t *testing.T, h http.Handler, method, path, body string, cookie *http.Cookie, mutate bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if mutate {
		req.Header.Set(RequestHeader, "1")
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func login(t *testing.T, h http.Handler, token string) *http.Cookie {
	t.Helper()
	rec := do(t, h, http.MethodPost, "/api/login", `{"token":"`+token+`"}`, nil, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("login: %d %s", rec.Code, rec.Body)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == CookieName {
			return c
		}
	}
	t.Fatal("login set no cookie")
	return nil
}

func TestLoginSetsAnHttpOnlyCookie(t *testing.T) {
	cluster := &fakeCluster{}
	h := newServer(cluster)
	cookie := login(t, h, "good")
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Value == "good" {
		t.Fatalf("cookie = %+v", cookie)
	}

	rec := do(t, h, http.MethodGet, "/api/session", "", cookie, false)
	var body sessionBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("session: %d %s", rec.Code, rec.Body)
	}
	if body.User.Username != "alice" || !body.Access.Reserve || body.ClusterName != "lab" {
		t.Fatalf("session = %+v", body)
	}
	if got := cluster.tokens[len(cluster.tokens)-1]; got != "good" {
		t.Fatalf("token passed to the cluster: %q", got)
	}
}

func TestLoginRejectsBadTokens(t *testing.T) {
	h := newServer(&fakeCluster{})
	for body, want := range map[string]int{
		`{"token":"bad"}`: http.StatusUnauthorized,
		`{"token":"  "}`:  http.StatusBadRequest,
		`not json`:        http.StatusBadRequest,
		`{"token":"` + strings.Repeat("x", 3000) + `"}`: http.StatusBadRequest,
	} {
		rec := do(t, h, http.MethodPost, "/api/login", body, nil, true)
		if rec.Code != want {
			t.Errorf("%.40s: status %d, want %d", body, rec.Code, want)
		}
		if len(rec.Result().Cookies()) > 0 {
			t.Errorf("%.40s: a cookie was set", body)
		}
	}
}

func TestLoginAcceptsBearerPrefix(t *testing.T) {
	cluster := &fakeCluster{}
	login(t, newServer(cluster), "Bearer good")
	if cluster.tokens[0] != "good" {
		t.Fatalf("token = %q", cluster.tokens[0])
	}
}

func TestRequestsWithoutSessionAre401(t *testing.T) {
	h := newServer(&fakeCluster{})
	for _, path := range []string{"/api/session", "/api/gpunodes"} {
		if rec := do(t, h, http.MethodGet, path, "", nil, false); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: %d", path, rec.Code)
		}
	}
}

func TestChangesNeedTheRequestHeaderAndSameOrigin(t *testing.T) {
	h := newServer(&fakeCluster{})
	cookie := login(t, h, "good")
	path := "/api/gpunodes/gpu-01/gpus/GPU-a/reservation"

	if rec := do(t, h, http.MethodPut, path, `{"reserved":true}`, cookie, false); rec.Code != http.StatusForbidden {
		t.Fatalf("without header: %d", rec.Code)
	}
	req := httptest.NewRequest(http.MethodPut, path, strings.NewReader(`{"reserved":true}`))
	req.Header.Set(RequestHeader, "1")
	req.Header.Set("Origin", "https://evil.example")
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("cross origin: %d", rec.Code)
	}
	if rec := do(t, h, http.MethodPost, "/api/login", `{"token":"good"}`, nil, false); rec.Code != http.StatusForbidden {
		t.Fatalf("login without header: %d", rec.Code)
	}
}

func TestSetReservation(t *testing.T) {
	cluster := &fakeCluster{}
	h := newServer(cluster)
	path := "/api/gpunodes/gpu-01/gpus/GPU-a/reservation"

	rec := do(t, h, http.MethodPut, path, `{"reserved":true}`, login(t, h, "good"), true)
	if rec.Code != http.StatusOK {
		t.Fatalf("editor: %d %s", rec.Code, rec.Body)
	}
	if r := cluster.reservation; r.node != "gpu-01" || r.uuid != "GPU-a" || !r.reserved {
		t.Fatalf("reservation = %+v", r)
	}
	if rec := do(t, h, http.MethodPut, path, `{"reserved":true}`, login(t, h, "viewer"), true); rec.Code != http.StatusForbidden {
		t.Fatalf("viewer: %d", rec.Code)
	}
	if rec := do(t, h, http.MethodPut, path, `{}`, login(t, h, "good"), true); rec.Code != http.StatusBadRequest {
		t.Fatalf("empty body: %d", rec.Code)
	}
}

func TestLogoutClearsTheCookie(t *testing.T) {
	h := newServer(&fakeCluster{})
	rec := do(t, h, http.MethodPost, "/api/logout", "", login(t, h, "good"), true)
	cookies := rec.Result().Cookies()
	if rec.Code != http.StatusNoContent || len(cookies) != 1 || cookies[0].MaxAge >= 0 {
		t.Fatalf("logout: %d %+v", rec.Code, cookies)
	}
}

func TestSecurityHeadersAndStaticFiles(t *testing.T) {
	h := newServer(&fakeCluster{})
	rec := do(t, h, http.MethodGet, "/", "", nil, false)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<!doctype html>") {
		t.Fatalf("index: %d %s", rec.Code, rec.Body)
	}
	csp := rec.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "script-src 'self'") || !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Fatalf("CSP = %q", csp)
	}
	if rec := do(t, h, http.MethodGet, "/api/nope", "", nil, false); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown API: %d", rec.Code)
	}
}

func TestGPUNodeEventsStreamChanges(t *testing.T) {
	eventDebounce = 10 * time.Millisecond
	cluster := &fakeCluster{}
	srv := httptest.NewServer(newServer(cluster))
	defer srv.Close()
	cookie := func() *http.Cookie {
		h := newServer(cluster)
		return login(t, h, "good")
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/gpunodes/events", nil)
	req.AddCookie(cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if ct := res.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q", ct)
	}

	events := make(chan string, 10)
	go func() {
		buf := make([]byte, 4096)
		var acc string
		for {
			n, err := res.Body.Read(buf)
			acc += string(buf[:n])
			for {
				i := strings.Index(acc, "\n\n")
				if i < 0 {
					break
				}
				events <- acc[:i]
				acc = acc[i+2:]
			}
			if err != nil {
				close(events)
				return
			}
		}
	}()
	next := func() string {
		select {
		case e := <-events:
			return e
		case <-time.After(5 * time.Second):
			t.Fatal("no event")
			return ""
		}
	}
	if e := next(); !strings.Contains(e, "event: gpunodes") || !strings.Contains(e, `"gpu-01"`) {
		t.Fatalf("first event: %q", e)
	}

	cluster.mu.Lock()
	cluster.nodes = []kube.GPUNode{{Name: "gpu-02"}}
	w := cluster.watcher
	cluster.mu.Unlock()
	for w == nil {
		time.Sleep(10 * time.Millisecond)
		cluster.mu.Lock()
		w = cluster.watcher
		cluster.mu.Unlock()
	}
	w.Modify(nil)
	w.Modify(nil) // debounced into one event
	if e := next(); !strings.Contains(e, `"gpu-02"`) {
		t.Fatalf("event after a change: %q", e)
	}
}

func TestGPUNodeEventsNeedASession(t *testing.T) {
	h := newServer(&fakeCluster{})
	if rec := do(t, h, http.MethodGet, "/api/gpunodes/events", "", nil, false); rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d", rec.Code)
	}
	bad := &http.Cookie{Name: CookieName, Value: "YmFk"} // "bad"
	if rec := do(t, h, http.MethodGet, "/api/gpunodes/events", "", bad, false); rec.Code != http.StatusUnauthorized {
		t.Fatalf("bad token: status %d", rec.Code)
	}
}

func TestWorkloadState(t *testing.T) {
	cluster := &fakeCluster{}
	h := newServer(cluster)
	path := "/api/workloads/ml/model/state"
	if rec := do(t, h, http.MethodPut, path, `{"state":"Suspended"}`, login(t, h, "good"), true); rec.Code != http.StatusNoContent {
		t.Fatalf("editor: %d %s", rec.Code, rec.Body)
	}
	if cluster.state != "Suspended" {
		t.Fatalf("state = %q", cluster.state)
	}
	if rec := do(t, h, http.MethodPut, path, `{"state":"Paused"}`, login(t, h, "good"), true); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid state: %d", rec.Code)
	}
	if rec := do(t, h, http.MethodPut, path, `{"state":"Running"}`, login(t, h, "viewer"), true); rec.Code != http.StatusForbidden {
		t.Fatalf("viewer: %d", rec.Code)
	}
	rec := do(t, h, http.MethodGet, "/api/workloads", "", login(t, h, "good"), false)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"model"`) {
		t.Fatalf("list: %d %s", rec.Code, rec.Body)
	}
}
