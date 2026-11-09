package main

import (
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/LucasSantana-Dev/cojam/server/internal/events"
	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
	"github.com/LucasSantana-Dev/cojam/server/internal/report"
)

// Product events (owner decision 2026-10-09). Rows are anonymous, kept 13
// months and read only through observability/postgres/grafana-ro.sql.

// eventsRetention is how long product_events rows live: 13 months, stated on
// /privacidade. A fixed constant, not an env knob: the page promises it. 13
// months is 395.6 days on average; 396 keeps the purge from ever running early.
const eventsRetention = 396 * 24 * time.Hour

// eventsShutdownFlush bounds the final flush so a hung database cannot hold up
// a deploy.
const eventsShutdownFlush = 5 * time.Second

// productEventSink is where handlers outside the hub (the Spotify exchange)
// emit. Nil until main wires it; emitting to nil is a no-op.
var productEventSink events.Sink

func emitProductEvent(e events.Event) {
	if productEventSink != nil {
		productEventSink.Emit(e)
	}
}

// eventsEnabled reads FEATURE_PRODUCT_EVENTS: on by default when a database is
// configured, off in in-memory mode (events would die with the process). An
// explicit value wins either way, but on without a database still records
// nothing: there is no table to write to.
func eventsEnabled(getenv func(string) string, haveDB bool) bool {
	return haveDB && featureEnabledIn(getenv, "FEATURE_PRODUCT_EVENTS", true)
}

// eventsKey returns the HMAC key and whether it came from EVENTS_HMAC_KEY.
// Unset gives a random per-process key: the hashes still work for counting
// distinct rooms inside one run but are not comparable across restarts.
func eventsKey(getenv func(string) string) (key []byte, configured bool) {
	if v := strings.TrimSpace(getenv("EVENTS_HMAC_KEY")); v != "" {
		return []byte(v), true
	}
	return events.GenerateKey(), false
}

// setupProductEvents builds the writer (a disabled one when events are off, so
// drops stay visible as music_jam_events_dropped_total{reason="disabled"}) and
// the retention sweep, and returns the writer plus a stop function that stops
// the sweep and flushes the buffer. Call stop before closing the pool.
func setupProductEvents(getenv func(string) string, logger *slog.Logger, metrics *obs.Metrics, pool *pgxpool.Pool) (*events.Writer, func()) {
	enabled := eventsEnabled(getenv, pool != nil)
	key, configured := eventsKey(getenv)
	if enabled && !configured {
		logger.Warn("events_hmac_key_unset",
			"hint", "set EVENTS_HMAC_KEY (32+ random bytes): without it room and actor hashes change on every restart, so distinct counts cannot be compared across deploys")
	}

	var ins events.Inserter
	var pg *events.Postgres
	if pool != nil {
		pg = events.NewPostgres(pool)
	}
	if enabled {
		ins = pg
	}
	w := events.NewWriter(events.NewHasher(key), ins, events.NewMetrics(metrics.Registry), logger, events.Config{})
	w.Start()

	// The purge runs whenever there is a database, even with the flag off:
	// rows written earlier still owe the 13 month promise.
	stopRetention := func() {}
	if pg != nil {
		r := report.NewRetention(eventsRetention, retentionBatch,
			report.RetentionTarget{Table: "product_events", Purger: pg},
		).WithLogger(logger).WithPurgeObserver(metrics.RetentionPurged)
		stopRetention = r.Start(retentionInterval)
	}

	if enabled {
		logger.Info("product_events_enabled", "retention_days", int(eventsRetention.Hours()/24), "stable_hashes", configured)
	} else {
		logger.Info("product_events_disabled", "hint", "needs DATABASE_URL and FEATURE_PRODUCT_EVENTS not set to false")
	}
	return w, func() {
		stopRetention()
		w.Close(eventsShutdownFlush)
	}
}
