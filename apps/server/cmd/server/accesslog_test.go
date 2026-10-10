package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The access log records method, path, status and duration only: never the
// query string (it can carry credentials) and never the client address.
func TestAccessLog_OmitsQueryAndClientAddress(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	h := accessLog(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/connection-token?userId=u-123&token=proof-value", nil)
	req.RemoteAddr = "203.0.113.77:5555"
	req.Header.Set("CF-Connecting-IP", "198.51.100.9")
	h.ServeHTTP(httptest.NewRecorder(), req)

	line := buf.String()
	for _, leaked := range []string{"proof-value", "u-123", "token=", "203.0.113.77", "198.51.100.9"} {
		if strings.Contains(line, leaked) {
			t.Fatalf("access log leaked %q: %s", leaked, line)
		}
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(line), &rec); err != nil {
		t.Fatalf("access log is not one JSON line: %v (%q)", err, line)
	}
	if rec["msg"] != "http_request" || rec["method"] != "GET" || rec["path"] != "/api/connection-token" || rec["status"] != float64(http.StatusTeapot) {
		t.Fatalf("unexpected access log record: %v", rec)
	}
	if _, ok := rec["duration_ms"]; !ok {
		t.Fatalf("missing duration_ms: %v", rec)
	}
}

// A handler that writes no explicit status is logged as 200.
func TestAccessLog_DefaultStatus(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	h := accessLog(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/healthz", nil))
	var rec map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rec); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if rec["status"] != float64(http.StatusOK) {
		t.Fatalf("status = %v, want 200", rec["status"])
	}
}

// A websocket upgrade that the handler took over (hijacked, nothing written
// through the wrapper) is logged once as 101 without a session-long
// duration; a rejected upgrade keeps its real status.
func TestAccessLog_WebsocketUpgrade(t *testing.T) {
	serve := func(handler http.HandlerFunc) map[string]any {
		t.Helper()
		var buf bytes.Buffer
		logger := slog.New(slog.NewJSONHandler(&buf, nil))
		req := httptest.NewRequest(http.MethodGet, "/connection/websocket", nil)
		req.Header.Set("Connection", "Upgrade")
		req.Header.Set("Upgrade", "websocket")
		accessLog(logger)(handler).ServeHTTP(httptest.NewRecorder(), req)
		var rec map[string]any
		if err := json.Unmarshal(buf.Bytes(), &rec); err != nil {
			t.Fatalf("decode: %v (%q)", err, buf.String())
		}
		return rec
	}

	upgraded := serve(func(w http.ResponseWriter, r *http.Request) {})
	if upgraded["status"] != float64(http.StatusSwitchingProtocols) {
		t.Fatalf("upgrade status = %v, want 101", upgraded["status"])
	}
	if _, ok := upgraded["duration_ms"]; ok {
		t.Fatalf("an upgraded session must not log a duration: %v", upgraded)
	}

	rejected := serve(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusForbidden) })
	if rejected["status"] != float64(http.StatusForbidden) {
		t.Fatalf("rejected upgrade status = %v, want 403", rejected["status"])
	}
}

// Health probes are logged only when they fail or are slow; other paths always.
func TestShouldLogRequest(t *testing.T) {
	cases := []struct {
		name   string
		path   string
		status int
		d      time.Duration
		want   bool
	}{
		{"readyz ok fast", "/readyz", 200, time.Millisecond, false},
		{"healthz ok fast", "/api/healthz", 200, time.Millisecond, false},
		{"readyz 503", "/readyz", 503, time.Millisecond, true},
		{"healthz 400", "/api/healthz", 400, time.Millisecond, true},
		{"healthz 399", "/api/healthz", 399, time.Millisecond, false},
		{"readyz slow", "/readyz", 200, 500 * time.Millisecond, true},
		{"healthz just fast", "/api/healthz", 200, 499 * time.Millisecond, false},
		{"other path ok fast", "/api/rooms", 200, time.Millisecond, true},
		{"similar path", "/readyz/x", 200, time.Millisecond, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldLogRequest(tc.path, tc.status, tc.d); got != tc.want {
				t.Fatalf("shouldLogRequest(%q, %d, %v) = %v, want %v", tc.path, tc.status, tc.d, got, tc.want)
			}
		})
	}
}

func TestAccessLog_QuietProbeEndToEnd(t *testing.T) {
	for _, tc := range []struct {
		status int
		lines  int
	}{{200, 0}, {503, 1}} {
		var buf bytes.Buffer
		logger := slog.New(slog.NewJSONHandler(&buf, nil))
		h := accessLog(logger)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.status)
		}))
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/readyz", nil))
		if got := strings.Count(buf.String(), "http_request"); got != tc.lines {
			t.Fatalf("status %d: %d lines, want %d", tc.status, got, tc.lines)
		}
	}
}
