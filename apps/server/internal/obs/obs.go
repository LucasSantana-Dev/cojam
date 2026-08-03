// Package obs holds the server's observability surface: prometheus metrics
// and the slog attribute conventions (method, room_id, duration_ms).
package obs

import (
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

type Metrics struct {
	Registry          *prometheus.Registry
	RPCDuration       *prometheus.HistogramVec
	ConnectionsActive prometheus.Gauge
	MatchConfidence   prometheus.Histogram
	MatchCacheHits    prometheus.Counter
	MatchCacheMisses  prometheus.Counter

	// Failure-path counters (#194/#195): store_errors_total is labeled by op
	// ("load"|"save"); the version-guard counter tracks stale writes the
	// Postgres upsert drops via RowsAffected (RFC-0001 semantics, observed
	// instead of silently diverging).
	StoreErrors               *prometheus.CounterVec
	StoreVersionGuardRejected prometheus.Counter
	RateLimitRejected         *prometheus.CounterVec
	RoomsEvicted              prometheus.Counter
	RoomsPersistedEvicted     prometheus.Counter
	PublishErrors             prometheus.Counter

	// Adoption counters (F1/F4/F8 usage signal).
	VotesCast        prometheus.Counter
	ChatMessagesSent prometheus.Counter
	RoomsListed      prometheus.Counter
	RoomsSetPublic   *prometheus.CounterVec
}

func New() *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		Registry: reg,
		RPCDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "music_jam_rpc_duration_seconds",
			Help:    "Room RPC latency by method and status.",
			Buckets: prometheus.DefBuckets,
		}, []string{"method", "status"}),
		ConnectionsActive: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "music_jam_connections_active",
			Help: "Currently connected realtime clients.",
		}),
		MatchConfidence: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "music_jam_match_confidence",
			Help:    "Cross-catalog track match confidence (0..1).",
			Buckets: prometheus.LinearBuckets(0, 0.1, 11),
		}),
		MatchCacheHits: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "music_jam_match_cache_hits_total",
			Help: "Total track matcher cache hits.",
		}),
		MatchCacheMisses: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "music_jam_match_cache_misses_total",
			Help: "Total track matcher cache misses.",
		}),
		StoreErrors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "music_jam_store_errors_total",
			Help: "Total room-store failures by operation.",
		}, []string{"op"}),
		StoreVersionGuardRejected: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "music_jam_store_version_guard_rejected_total",
			Help: "Total stale room saves dropped by the Postgres version guard.",
		}),
		RateLimitRejected: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "music_jam_rate_limit_rejected_total",
			Help: "Total RPCs rejected by a per-caller rate limiter.",
		}, []string{"method"}),
		RoomsEvicted: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "music_jam_rooms_evicted_total",
			Help: "Total idle rooms evicted from hub memory.",
		}),
		RoomsPersistedEvicted: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "music_jam_rooms_persisted_evicted_total",
			Help: "Total idle room rows deleted from the persistent store.",
		}),
		PublishErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "music_jam_publish_errors_total",
			Help: "Total room-channel publication failures.",
		}),
		VotesCast: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "music_jam_votes_cast_total",
			Help: "Total queue.vote toggles applied (F4 adoption).",
		}),
		ChatMessagesSent: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "music_jam_chat_messages_sent_total",
			Help: "Total chat messages sent (F8 adoption).",
		}),
		RoomsListed: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "music_jam_rooms_listed_total",
			Help: "Total room.list directory reads served (F1 adoption).",
		}),
		RoomsSetPublic: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "music_jam_rooms_set_public_total",
			Help: "Total room.set_public toggles applied, by target visibility.",
		}, []string{"public"}),
	}
	reg.MustRegister(m.RPCDuration, m.ConnectionsActive, m.MatchConfidence, m.MatchCacheHits, m.MatchCacheMisses,
		m.StoreErrors, m.StoreVersionGuardRejected, m.RateLimitRejected, m.RoomsEvicted, m.RoomsPersistedEvicted,
		m.PublishErrors, m.VotesCast, m.ChatMessagesSent, m.RoomsListed, m.RoomsSetPublic)
	return m
}

// RegisterRoomsGauge exposes a live room count from the given callback.
func (m *Metrics) RegisterRoomsGauge(count func() float64) {
	m.Registry.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "music_jam_rooms_active",
		Help: "Rooms currently held in the hub.",
	}, count))
}

// ObserveRPC records one RPC duration under a status label: "ok", "error"
// (server fault), or "user_error" (client mistake, e.g. bad input). The
// caller classifies; obs cannot import hub's UserError without a cycle.
func (m *Metrics) ObserveRPC(method, status string, d time.Duration) {
	m.RPCDuration.WithLabelValues(method, status).Observe(d.Seconds())
}

func (m *Metrics) ConnInc() { m.ConnectionsActive.Inc() }
func (m *Metrics) ConnDec() { m.ConnectionsActive.Dec() }

func (m *Metrics) ObserveMatchConfidence(c float64) { m.MatchConfidence.Observe(c) }

func (m *Metrics) MatchCacheHit()  { m.MatchCacheHits.Inc() }
func (m *Metrics) MatchCacheMiss() { m.MatchCacheMisses.Inc() }

// StoreError counts one room-store failure ("load"|"save").
func (m *Metrics) StoreError(op string) { m.StoreErrors.WithLabelValues(op).Inc() }

// StoreVersionGuardReject counts one stale save dropped by the version guard.
func (m *Metrics) StoreVersionGuardReject() { m.StoreVersionGuardRejected.Inc() }

// RateLimitReject counts one rate-limited RPC by method.
func (m *Metrics) RateLimitReject(method string) { m.RateLimitRejected.WithLabelValues(method).Inc() }

func (m *Metrics) RoomEvicted()     { m.RoomsEvicted.Inc() }
func (m *Metrics) PublishError()    { m.PublishErrors.Inc() }
func (m *Metrics) VoteCast()        { m.VotesCast.Inc() }
func (m *Metrics) ChatMessageSent() { m.ChatMessagesSent.Inc() }
func (m *Metrics) RoomListed()      { m.RoomsListed.Inc() }

// RoomPersistedEvicted counts n room rows deleted by the persistent idle
// sweep (#169). Named distinctly from the counter field it wraps, matching
// RoomEvicted/RoomsEvicted.
func (m *Metrics) RoomPersistedEvicted(n int64) { m.RoomsPersistedEvicted.Add(float64(n)) }

// RoomSetPublic counts one room.set_public toggle by target visibility.
func (m *Metrics) RoomSetPublic(public bool) {
	m.RoomsSetPublic.WithLabelValues(strconv.FormatBool(public)).Inc()
}
