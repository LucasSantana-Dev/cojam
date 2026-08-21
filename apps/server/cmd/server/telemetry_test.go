package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
)

func postTelemetry(t *testing.T, h http.HandlerFunc, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/telemetry", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func newHandler() (http.HandlerFunc, *obs.Metrics) {
	m := obs.New()
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	return telemetryHandler(m, logger, newTelemetryLimiter()), m
}

func TestTelemetry_AcceptsAllowlistedNames(t *testing.T) {
	h, _ := newHandler()
	for _, body := range []string{
		`{"type":"event","name":"room_create"}`,
		`{"type":"vital","name":"LCP","value":1200}`,
		`{"type":"error","name":"boundary_root","detail":"TypeError: x is not a function"}`,
	} {
		if rec := postTelemetry(t, h, body); rec.Code != http.StatusNoContent {
			t.Errorf("body %s: expected 204, got %d", body, rec.Code)
		}
	}
}

// The cardinality guard. A free-text label would let any caller create
// unbounded Prometheus series, which is the failure mode most likely to take
// down the metrics stack.
func TestTelemetry_RejectsUnknownNames(t *testing.T) {
	h, _ := newHandler()
	for _, body := range []string{
		`{"type":"event","name":"attacker_controlled_label"}`,
		// Counted server-side as rooms_shared_total; must not be accepted here.
		`{"type":"event","name":"second_listener"}`,
		`{"type":"vital","name":"NOT_A_VITAL","value":1}`,
		`{"type":"error","name":"../../etc/passwd"}`,
		`{"type":"event","name":""}`,
		`{"type":"nonsense","name":"room_join"}`,
	} {
		if rec := postTelemetry(t, h, body); rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: expected 400, got %d", body, rec.Code)
		}
	}
}

func TestTelemetry_RejectsMalformedBody(t *testing.T) {
	h, _ := newHandler()
	if rec := postTelemetry(t, h, `{"type":`); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for truncated JSON, got %d", rec.Code)
	}
}

// An oversized body must not be read into memory in full.
func TestTelemetry_CapsBodySize(t *testing.T) {
	h, _ := newHandler()
	huge := `{"type":"error","name":"boundary_root","detail":"` + strings.Repeat("a", 64<<10) + `"}`
	// Truncated at the cap, so the JSON no longer parses: 400, not a hang.
	if rec := postTelemetry(t, h, huge); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an oversized body, got %d", rec.Code)
	}
}

func TestTelemetry_RateLimits(t *testing.T) {
	h, _ := newHandler()
	body := `{"type":"event","name":"landing_view"}`

	var limited bool
	for i := 0; i < telemetryBurst*3; i++ {
		if postTelemetry(t, h, body).Code == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("expected the limiter to reject a sustained flood")
	}
}

// Byte slicing a multi-byte rune emits invalid UTF-8; #185 fixed exactly this
// class for chat truncation.
func TestTruncateRunes_IsRuneSafe(t *testing.T) {
	in := strings.Repeat("é", telemetryMaxDetail+50)
	got := truncateRunes(in, telemetryMaxDetail)

	if n := len([]rune(got)); n != telemetryMaxDetail {
		t.Fatalf("expected %d runes, got %d", telemetryMaxDetail, n)
	}
	if !strings.HasPrefix(in, got) {
		t.Error("truncation must be a prefix of the input")
	}
	for _, r := range got {
		if r == '�' {
			t.Fatal("truncation split a rune")
		}
	}
}

func TestTruncateRunes_ShortInputUnchanged(t *testing.T) {
	if got := truncateRunes("short", telemetryMaxDetail); got != "short" {
		t.Fatalf("expected input unchanged, got %q", got)
	}
}

// Distinct callers must not share a bucket, or one noisy client silences
// everyone else's telemetry.
func TestTelemetryLimiter_IsPerCaller(t *testing.T) {
	l := newTelemetryLimiter()
	now := time.Now()

	for i := 0; i < telemetryBurst; i++ {
		if !l.allow("1.1.1.1", now) {
			t.Fatalf("first caller exhausted early at %d", i)
		}
	}
	if l.allow("1.1.1.1", now) {
		t.Fatal("first caller should be limited")
	}
	if !l.allow("2.2.2.2", now) {
		t.Fatal("a different caller must have its own bucket")
	}
}

func TestTelemetryLimiter_RefillsOverTime(t *testing.T) {
	l := newTelemetryLimiter()
	now := time.Now()

	for i := 0; i < telemetryBurst; i++ {
		l.allow("1.1.1.1", now)
	}
	if l.allow("1.1.1.1", now) {
		t.Fatal("expected exhaustion")
	}
	if !l.allow("1.1.1.1", now.Add(telemetryRefill*2)) {
		t.Fatal("expected the bucket to refill over time")
	}
}

func TestCallerKey_PrefersForwardedFor(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/telemetry", nil)
	req.Header.Set("X-Forwarded-For", "203.0.113.5, 70.41.3.18")
	if got := callerKey(req); got != "203.0.113.5" {
		t.Fatalf("expected the client IP, got %q", got)
	}

	bare := httptest.NewRequest(http.MethodPost, "/api/telemetry", nil)
	if got := callerKey(bare); got == "" {
		t.Fatal("expected a fallback key when the header is absent")
	}
}
