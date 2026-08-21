package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The public probe must not leak the build stamp: it is internet-facing, and
// the version only helps fingerprint the deployment. The private /healthz keeps
// carrying it (#268).
func TestPublicHealthz(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/healthz", nil)
	rec := httptest.NewRecorder()
	publicHealthzHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("expected Cache-Control no-store, got %q", got)
	}

	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decoding body: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("expected status ok, got %q", body["status"])
	}
	if _, leaked := body["version"]; leaked {
		t.Error("public probe must not expose the build version")
	}
}

// The private probe keeps the version: it is on the internal listener and
// answering "what is deployed" during an incident is the point.
func TestPrivateHealthzKeepsVersion(t *testing.T) {
	rec := httptest.NewRecorder()
	healthzHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decoding body: %v", err)
	}
	if body["version"] == "" {
		t.Error("private /healthz should report the build version")
	}
}
