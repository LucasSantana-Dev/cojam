package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/hub"
)

// The live counter exposes totals only, never room ids or per-room data (#307).
func TestLiveStatsHandler_TotalsOnly(t *testing.T) {
	h := hub.NewHub(nil)
	h.Join("a", "hidden-room")
	h.Join("b", "hidden-room")

	rec := httptest.NewRecorder()
	liveStatsHandler(h).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/stats/live", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var body map[string]int
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decoding body: %v", err)
	}
	if len(body) != 2 || body["people"] != 2 || body["rooms"] != 1 {
		t.Errorf("body = %v, want exactly people=2 rooms=1", body)
	}
	if strings.Contains(rec.Body.String(), "hidden-room") {
		t.Error("response leaks a room id")
	}
}
