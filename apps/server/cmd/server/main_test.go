package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// /healthz reports liveness plus the build-stamped version so a deploy can be
// identified in a browser (#201). Local test runs build without ldflags, so
// the version is the "dev" default; CI image builds stamp <ref>@<sha>.
func TestHealthzHandler_ReportsVersion(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)

	healthzHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if body["status"] != "ok" {
		t.Fatalf("status field = %q, want \"ok\"", body["status"])
	}
	if body["version"] != version {
		t.Fatalf("version field = %q, want the build-stamped %q", body["version"], version)
	}
	if body["version"] == "" {
		t.Fatal("version field must never be empty")
	}
}

// In memory mode (no pool), readiness is always OK: there is no database whose
// health could gate serving. The Postgres-unreachable path needs a live DB and
// is exercised by the deploy health check, not a unit test.
func TestReadyzHandler_MemoryModeReady(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)

	readyzHandler(nil).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if body["status"] != "ready" {
		t.Fatalf("status field = %q, want \"ready\"", body["status"])
	}
}
