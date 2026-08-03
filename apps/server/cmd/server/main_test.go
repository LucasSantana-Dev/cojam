package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// presenceConnInfo forwards {name, platform?} into presence ConnInfo (#171):
// the platform indicator in the UI must come from live presence, which only
// carries what the server stamps at connect time.
func TestPresenceConnInfo(t *testing.T) {
	cases := []struct {
		name string
		data string
		want map[string]string
	}{
		{"name only", `{"name":"Alice"}`, map[string]string{"name": "Alice"}},
		{"name and platform", `{"name":"Bob","platform":"spotify"}`, map[string]string{"name": "Bob", "platform": "spotify"}},
		{"apple", `{"name":"A","platform":"apple"}`, map[string]string{"name": "A", "platform": "apple"}},
		{"youtube", `{"name":"A","platform":"youtube"}`, map[string]string{"name": "A", "platform": "youtube"}},
		// Unknown platforms are dropped so presence only carries renderable values.
		{"unknown platform dropped", `{"name":"A","platform":"tiktok"}`, map[string]string{"name": "A"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := presenceConnInfo([]byte(tc.data))
			var decoded map[string]string
			if err := json.Unmarshal(got, &decoded); err != nil {
				t.Fatalf("output not JSON: %v", err)
			}
			if len(decoded) != len(tc.want) {
				t.Fatalf("got %v, want %v", decoded, tc.want)
			}
			for k, v := range tc.want {
				if decoded[k] != v {
					t.Fatalf("got %v, want %v", decoded, tc.want)
				}
			}
		})
	}
}

func TestPresenceConnInfo_NoName(t *testing.T) {
	for _, data := range []string{`{"platform":"spotify"}`, `not json`, `{}`} {
		if got := presenceConnInfo([]byte(data)); got != nil {
			t.Fatalf("presenceConnInfo(%s) = %s, want nil", data, got)
		}
	}
}

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
