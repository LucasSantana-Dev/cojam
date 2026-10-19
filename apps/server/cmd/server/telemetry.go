package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"net/http"
	"slices"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
)

// Telemetry bounds. The body cap is the inbound counterpart to
// httpx.MaxResponseBytes: this endpoint is an unauthenticated write from the
// public internet.
const (
	telemetryMaxBody    = 4 << 10 // 4 KiB
	telemetryMaxDetail  = 300     // runes, not bytes
	telemetryBurst      = 20
	telemetryRefill     = 3 * time.Second
	telemetryIdleTTL    = time.Hour
	telemetrySweepEvery = time.Minute
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

// syncDriftPayload is decoded strictly: unknown fields are a rejection, so the
// schema cannot quietly grow to carry ids or user data.
type syncDriftPayload struct {
	Type     string  `json:"type"`
	Name     string  `json:"name"`
	DriftMs  float64 `json:"driftMs"`
	Player   string  `json:"player"`
	CanSeek  *bool   `json:"canSeek"`
	Hidden   *bool   `json:"hidden"`
	RttMs    float64 `json:"rttMs"`
	Platform string  `json:"platform"`
}

func validSyncDrift(p syncDriftPayload) bool {
	if p.Name != "sync_drift" || p.CanSeek == nil || p.Hidden == nil {
		return false
	}
	if math.IsNaN(p.DriftMs) || math.Abs(p.DriftMs) > obs.MaxDriftMs {
		return false
	}
	if math.IsNaN(p.RttMs) || p.RttMs < 0 || p.RttMs > 600000 {
		return false
	}
	return slices.Contains(obs.DriftPlayers, p.Player) && slices.Contains(obs.DriftPlatforms, p.Platform)
}

type telemetryPayload struct {
	Type   string  `json:"type"`
	Name   string  `json:"name"`
	Value  float64 `json:"value"`
	Detail string  `json:"detail"`
}

// callerLimiter is a per-key token bucket limiter. Each public endpoint gets
// its own instance so one endpoint cannot spend another's budget. Refill is
// computed lazily per key, and idle buckets are swept at most once per
// sweepEvery interval so the map cannot grow unboundedly.
type callerBucket struct {
	tokens float64
	last   time.Time
}

type callerLimiter struct {
	mu         sync.Mutex
	burst      float64
	refill     time.Duration
	idleTTL    time.Duration
	sweepEvery time.Duration
	lastSweep  time.Time
	buckets    map[string]*callerBucket
}

func newCallerLimiter(burst float64, refill time.Duration) *callerLimiter {
	return &callerLimiter{
		burst:      burst,
		refill:     refill,
		idleTTL:    telemetryIdleTTL,
		sweepEvery: telemetrySweepEvery,
		buckets:    make(map[string]*callerBucket),
	}
}

func newTelemetryLimiter() *callerLimiter {
	return newCallerLimiter(telemetryBurst, telemetryRefill)
}

func (l *callerLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.sweepLocked(now)
	b := l.refillLocked(key, now)
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// refillLocked returns key's bucket, created full on first use and refilled
// for elapsed time since its last access. Callers must hold l.mu.
func (l *callerLimiter) refillLocked(key string, now time.Time) *callerBucket {
	b, ok := l.buckets[key]
	if !ok {
		b = &callerBucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens += float64(now.Sub(b.last)) / float64(l.refill)
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	return b
}

// sweepLocked evicts idle buckets at most once per sweepEvery. Callers must hold l.mu.
func (l *callerLimiter) sweepLocked(now time.Time) {
	if now.Sub(l.lastSweep) < l.sweepEvery {
		return
	}
	for k, b := range l.buckets {
		if now.Sub(b.last) > l.idleTTL {
			delete(l.buckets, k)
		}
	}
	l.lastSweep = now
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

// telemetryHandler accepts one client-reported error, product event, or web
// vital and folds it into the existing Prometheus surface. See
// docs/specs/245-251-client-telemetry.md for why this is not Sentry.
func telemetryHandler(metrics *obs.Metrics, logger *slog.Logger, limiter *callerLimiter) http.HandlerFunc {
	obs.EnsureDrift(metrics)
	return func(w http.ResponseWriter, r *http.Request) {
		if !limiter.allow(callerKey(r), time.Now()) {
			metrics.TelemetryRejected("rate_limited")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}

		raw, err := io.ReadAll(io.LimitReader(r.Body, telemetryMaxBody))
		var p telemetryPayload
		if err == nil {
			err = json.Unmarshal(raw, &p)
		}
		if err != nil {
			metrics.TelemetryRejected("malformed")
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		switch p.Type {
		case "sample":
			var d syncDriftPayload
			dec := json.NewDecoder(bytes.NewReader(raw))
			dec.DisallowUnknownFields()
			if err := dec.Decode(&d); err != nil {
				metrics.TelemetryRejected("malformed")
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if d.Name != "sync_drift" {
				metrics.TelemetryRejected("unknown_name")
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if !validSyncDrift(d) {
				metrics.TelemetryRejected("invalid_sample")
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			metrics.SyncDrift(d.Player, d.Platform, *d.Hidden, d.DriftMs)
			logger.Debug("sync_drift", "player", d.Player, "platform", d.Platform,
				"hidden", *d.Hidden, "driftMs", d.DriftMs)
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
