package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
)

// Telemetry bounds. The body cap is the inbound counterpart to
// httpx.MaxResponseBytes: this endpoint is an unauthenticated write from the
// public internet.
const (
	telemetryMaxBody   = 4 << 10 // 4 KiB
	telemetryMaxDetail = 300     // runes, not bytes
	telemetryBurst     = 20
	telemetryRefill    = 3 * time.Second
)

// Allowlisted names per type. Prometheus labels are taken from these maps and
// never from the request, because an attacker-controlled label creates
// unbounded time series and takes down the metrics stack.
var (
	// "second_listener" is deliberately absent: the hub already counts that as
	// music_jam_rooms_shared_total (#180), server-side and per-room. Accepting
	// it here too would double-count.
	telemetryEvents = map[string]bool{
		"landing_view": true, "room_create": true, "room_join": true,
		"track_added": true, "provider_connected": true,
	}
	telemetryVitals = map[string]bool{"LCP": true, "INP": true, "CLS": true}
	telemetryErrors = map[string]bool{
		"boundary_segment": true, "boundary_root": true, "ws_terminal": true,
		"playback_failed": true, "token_refresh_failed": true,
	}
)

type telemetryPayload struct {
	Type   string  `json:"type"`
	Name   string  `json:"name"`
	Value  float64 `json:"value"`
	Detail string  `json:"detail"`
}

// callerLimiter is a token bucket keyed by caller, mirroring the hub's
// rateLimiter. Each public endpoint gets its own instance so one cannot spend
// another's budget, and none of them spend the hub's.
type callerLimiter struct {
	mu      sync.Mutex
	burst   float64
	refill  time.Duration
	buckets map[string]float64
	seen    map[string]time.Time
	last    time.Time
}

func newCallerLimiter(burst float64, refill time.Duration) *callerLimiter {
	return &callerLimiter{
		burst:   burst,
		refill:  refill,
		buckets: map[string]float64{},
		seen:    map[string]time.Time{},
		last:    time.Now(),
	}
}

func newTelemetryLimiter() *callerLimiter {
	return newCallerLimiter(telemetryBurst, telemetryRefill)
}

func (l *callerLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	// buckets hold tokens CONSUMED, so refill decreases them. A caller back at
	// zero is indistinguishable from one never seen, so drop the entry.
	if elapsed := now.Sub(l.last); elapsed > 0 {
		refill := float64(elapsed) / float64(l.refill)
		for k := range l.buckets {
			if v := l.buckets[k] - refill; v <= 0 {
				delete(l.buckets, k)
			} else {
				l.buckets[k] = v
			}
		}
		l.last = now
	}
	// Evict callers unseen for an hour so the maps stay bounded.
	for k, t := range l.seen {
		if now.Sub(t) > time.Hour {
			delete(l.seen, k)
			delete(l.buckets, k)
		}
	}
	l.seen[key] = now

	if l.buckets[key] >= l.burst {
		return false
	}
	l.buckets[key]++
	return true
}

// truncateRunes cuts s to at most n runes. Byte slicing would split a
// multi-byte rune and emit invalid UTF-8 (#185).
func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	count := 0
	for i := range s {
		if count == n {
			return s[:i]
		}
		count++
	}
	return s
}

// callerKey identifies a caller for rate limiting. The proxy sets
// X-Forwarded-For; RemoteAddr is the fallback for direct connections.
func callerKey(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if i := strings.IndexByte(fwd, ','); i >= 0 {
			return strings.TrimSpace(fwd[:i])
		}
		return strings.TrimSpace(fwd)
	}
	return r.RemoteAddr
}

// telemetryHandler accepts one client-reported error, product event, or web
// vital and folds it into the existing Prometheus surface. See
// docs/specs/245-251-client-telemetry.md for why this is not Sentry.
func telemetryHandler(metrics *obs.Metrics, logger *slog.Logger, limiter *callerLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !limiter.allow(callerKey(r), time.Now()) {
			metrics.TelemetryRejected("rate_limited")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}

		var p telemetryPayload
		if err := json.NewDecoder(io.LimitReader(r.Body, telemetryMaxBody)).Decode(&p); err != nil {
			metrics.TelemetryRejected("malformed")
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		switch p.Type {
		case "event":
			if !telemetryEvents[p.Name] {
				metrics.TelemetryRejected("unknown_name")
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			metrics.ProductEvent(p.Name)
		case "vital":
			if !telemetryVitals[p.Name] {
				metrics.TelemetryRejected("unknown_name")
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			metrics.WebVital(p.Name, p.Value)
		case "error":
			if !telemetryErrors[p.Name] {
				metrics.TelemetryRejected("unknown_name")
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			metrics.ClientError(p.Name)
			logger.Warn("client_error", "name", p.Name,
				"detail", truncateRunes(p.Detail, telemetryMaxDetail))
		default:
			metrics.TelemetryRejected("unknown_type")
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
