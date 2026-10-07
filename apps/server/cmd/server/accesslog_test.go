package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
