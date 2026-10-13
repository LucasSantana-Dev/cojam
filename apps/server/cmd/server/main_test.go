package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
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
		// Apple Music was removed (2026-10-08): a stale client sending it gets no platform.
		{"legacy apple dropped", `{"name":"A","platform":"apple"}`, map[string]string{"name": "A"}},
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

// The connect-time display name is capped at maxDisplayNameLen runes
// (rune-safe) and trimmed; it feeds presence, queue attribution and chat.
func TestPresenceConnInfo_CapsName(t *testing.T) {
	long := strings.Repeat("名", maxDisplayNameLen+5) + "🎧"
	got := presenceConnInfo([]byte(`{"name":"` + long + `"}`))
	var decoded map[string]string
	if err := json.Unmarshal(got, &decoded); err != nil {
		t.Fatalf("output not JSON: %v", err)
	}
	if n := utf8.RuneCountInString(decoded["name"]); n != maxDisplayNameLen || !utf8.ValidString(decoded["name"]) {
		t.Fatalf("name = %q (%d runes), want %d valid runes", decoded["name"], n, maxDisplayNameLen)
	}

	got = presenceConnInfo([]byte(`{"name":"  Ana  "}`))
	if err := json.Unmarshal(got, &decoded); err != nil || decoded["name"] != "Ana" {
		t.Fatalf("name must be trimmed: %s", got)
	}
	if got := presenceConnInfo([]byte(`{"name":"   "}`)); got != nil {
		t.Fatalf("blank name must yield no ConnInfo, got %s", got)
	}
}

func TestEnvPositiveInt(t *testing.T) {
	env := map[string]string{"A": "250", "B": "0", "C": "x", "D": " 7 "}
	get := func(k string) string { return env[k] }
	for key, want := range map[string]int{"A": 250, "B": 30, "C": 30, "D": 7, "MISSING": 30} {
		if got := envPositiveInt(get, key, 30); got != want {
			t.Errorf("%s: got %d, want %d", key, got, want)
		}
	}
}

func TestParseOrigins(t *testing.T) {
	cases := []struct {
		name  string
		raw   string
		want  map[string]bool
	}{
		{
			"blank defaults to localhost",
			"",
			map[string]bool{"http://localhost:3000": true, "http://127.0.0.1:3000": true},
		},
		{
			"whitespace-only defaults to localhost",
			"   ",
			map[string]bool{"http://localhost:3000": true, "http://127.0.0.1:3000": true},
		},
		{
			"single origin",
			"https://cojam.app",
			map[string]bool{"https://cojam.app": true},
		},
		{
			"comma-separated list",
			"https://cojam.app,https://staging.cojam.app",
			map[string]bool{"https://cojam.app": true, "https://staging.cojam.app": true},
		},
		{
			"padded comma list",
			"  https://a.com ,  https://b.com  ",
			map[string]bool{"https://a.com": true, "https://b.com": true},
		},
		{
			"wildcard passthrough",
			"*",
			map[string]bool{"*": true},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseOrigins(tc.raw)
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for k := range tc.want {
				if !got[k] {
					t.Errorf("missing origin %q in %v", k, got)
				}
			}
		})
	}
}

func TestFeatureEnabledIn(t *testing.T) {
	cases := []struct {
		val  string
		dflt bool
		want bool
	}{
		{"1", false, true},
		{"true", false, true},
		{"on", false, true},
		{"yes", false, true},
		{"TRUE", false, true},
		{"ON", false, true},
		{"0", true, false},
		{"false", true, false},
		{"off", true, false},
		{"no", true, false},
		{"FALSE", true, false},
		{"", true, true},
		{"", false, false},
		{"unknown", true, true},
		{"unknown", false, false},
	}
	for _, tc := range cases {
		get := func(string) string { return tc.val }
		if got := featureEnabledIn(get, "KEY", tc.dflt); got != tc.want {
			t.Errorf("featureEnabledIn(%q, dflt=%v) = %v, want %v", tc.val, tc.dflt, got, tc.want)
		}
	}
}

func TestEnvDurationMinutes(t *testing.T) {
	dflt := 30 * time.Minute
	cases := []struct {
		val  string
		want time.Duration
	}{
		{"", dflt},
		{"  ", dflt},
		{"0", dflt},
		{"-1", dflt},
		{"garbage", dflt},
		{"1", 1 * time.Minute},
		{"60", 60 * time.Minute},
		{" 45 ", 45 * time.Minute},
	}
	for _, tc := range cases {
		get := func(string) string { return tc.val }
		if got := envDurationMinutes(get, "KEY", dflt); got != tc.want {
			t.Errorf("envDurationMinutes(%q) = %v, want %v", tc.val, got, tc.want)
		}
	}
}

// readyzHandler returns 503 when the pool cannot reach the database.
// 127.0.0.1:1 is a refused port (nothing listens there).
func TestReadyzHandler_PostgresUnreachable(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, "postgres://x:x@127.0.0.1:1/x")
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)

	readyzHandler(pool).ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if body["status"] != "not ready" {
		t.Fatalf("status field = %q, want \"not ready\"", body["status"])
	}
}
