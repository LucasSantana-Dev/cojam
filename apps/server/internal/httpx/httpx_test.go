package httpx

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type payload struct {
	Name string `json:"name"`
}

func get(t *testing.T, url string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("building request: %v", err)
	}
	return req
}

func TestDoJSON_DecodesSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"name":"cojam"}`))
	}))
	defer srv.Close()

	var got payload
	if err := DoJSON(get(t, srv.URL), &got); err != nil {
		t.Fatalf("DoJSON: %v", err)
	}
	if got.Name != "cojam" {
		t.Fatalf("got %q, want %q", got.Name, "cojam")
	}
}

// The upstream body must never reach the error string: these responses come
// from third parties and can carry tokens echoed back from our own request.
func TestDoJSON_NonSuccessDoesNotLeakBody(t *testing.T) {
	const secret = "SUPER_SECRET_TOKEN_VALUE"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"error":"` + secret + `"}`))
	}))
	defer srv.Close()

	var got payload
	err := DoJSON(get(t, srv.URL), &got)
	if err == nil {
		t.Fatal("expected an error for a 403 response")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("error leaked the upstream body: %v", err)
	}
	if !strings.Contains(err.Error(), "403") {
		t.Fatalf("expected the status code in the error, got %v", err)
	}
}

func TestDoJSON_MalformedJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"name":`))
	}))
	defer srv.Close()

	var got payload
	if err := DoJSON(get(t, srv.URL), &got); err == nil {
		t.Fatal("expected a decode error for truncated JSON")
	}
}

// A hostile upstream must not be able to stream unbounded data into memory.
func TestDoJSON_CapsResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// An array that never terminates: decode can only stop at the cap.
		w.Write([]byte(`{"name":"`))
		chunk := strings.Repeat("a", 64<<10)
		for {
			if _, err := w.Write([]byte(chunk)); err != nil {
				return // client hung up, which is the expected outcome
			}
			select {
			case <-r.Context().Done():
				return
			default:
			}
		}
	}))
	defer srv.Close()

	done := make(chan error, 1)
	go func() {
		var got payload
		done <- DoJSON(get(t, srv.URL), &got)
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected an error rather than an unbounded read")
		}
	case <-time.After(30 * time.Second):
		t.Fatal("DoJSON did not return: the response body is not bounded")
	}
}

func TestDoJSON_TransportErrorPropagates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close() // nothing is listening now

	var got payload
	err := DoJSON(get(t, url), &got)
	if err == nil {
		t.Fatal("expected a transport error against a closed server")
	}
	if errors.Is(err, io.EOF) {
		t.Fatalf("expected a connection error, got %v", err)
	}
}

// Guards the timeout posture this package exists to provide. A regression here
// means a slow upstream can pin a request goroutine.
func TestClient_TimeoutsAreBounded(t *testing.T) {
	if Client.Timeout <= 0 {
		t.Fatal("Client.Timeout must be set: an unbounded call can hang a goroutine")
	}
	tr, ok := Client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("expected *http.Transport, got %T", Client.Transport)
	}
	if tr.TLSHandshakeTimeout <= 0 {
		t.Error("TLSHandshakeTimeout must be set")
	}
	if tr.ResponseHeaderTimeout <= 0 {
		t.Error("ResponseHeaderTimeout must be set")
	}
	if tr.ResponseHeaderTimeout >= Client.Timeout {
		t.Errorf("ResponseHeaderTimeout (%v) should be below the overall timeout (%v)",
			tr.ResponseHeaderTimeout, Client.Timeout)
	}
}

// A slow upstream must be cut off by Client.Timeout rather than hanging.
func TestDoJSON_SlowUpstreamTimesOut(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-release
	}))
	defer srv.Close()
	defer close(release)

	restore := Client.Timeout
	Client.Timeout = 150 * time.Millisecond
	defer func() { Client.Timeout = restore }()

	var got payload
	start := time.Now()
	if err := DoJSON(get(t, srv.URL), &got); err == nil {
		t.Fatal("expected a timeout error")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("timeout did not fire promptly: took %v", elapsed)
	}
}
