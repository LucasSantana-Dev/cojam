package obs

import (
	"log/slog"
	"runtime/debug"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

// Latency buckets for local work (store write, channel publish).
var fastBuckets = []float64{.001, .0025, .005, .01, .025, .05, .1, .25, .5, 1, 2.5}

// Latency buckets for outbound provider calls.
var providerBuckets = []float64{.05, .1, .25, .5, 1, 2, 5, 10}

// Provider, op and status values are bounded enums. Free text never reaches a
// label: httpx maps a host to one of these providers and the caller names the op.
var (
	Providers = []string{"youtube", "spotify", "deezer", "lyrics", "other"}
	// ProviderStatuses classifies one outbound call.
	ProviderStatuses = []string{"ok", "error", "quota", "ratelimit", "timeout"}
	// ProviderOps are the operations callers may name; anything else is "other".
	ProviderOps = []string{"search", "lookup", "playlist", "token", "lyrics", "similar", "isrc", "jwks", "other"}
)

// foundation holds the series added by the observability foundation work:
// store and publish latency, outbound provider calls, the YouTube quota
// breaker and recovered goroutine panics.
type foundation struct {
	StoreSaveDuration prometheus.Histogram
	PublishDuration   prometheus.Histogram
	ProviderRequests  *prometheus.CounterVec
	ProviderDuration  *prometheus.HistogramVec
	YouTubeQuotaTrips *prometheus.CounterVec
	GoroutinePanics   *prometheus.CounterVec
}

// panicCounter is read by SafeGo. Goroutines start in packages that do not
// hold a *Metrics, so the counter is reachable package-wide, set by New.
var panicCounter atomic.Pointer[prometheus.CounterVec]

// SafeGoWheres are the known goroutine labels, initialised at boot.
var SafeGoWheres = []string{"hub_enrich", "hub_evict", "hub_heartbeat", "match_search", "report_notify", "report_retention", "moderation_audit", "search_purge"}

func (m *Metrics) registerFoundation() {
	m.StoreSaveDuration = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "music_jam_store_save_duration_seconds",
		Help:    "Room store Save latency.",
		Buckets: fastBuckets,
	})
	m.PublishDuration = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "music_jam_publish_duration_seconds",
		Help:    "Room channel publish latency.",
		Buckets: fastBuckets,
	})
	m.ProviderRequests = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "music_jam_provider_requests_total",
		Help: "Outbound provider HTTP calls by provider, op and status (ok|error|quota|ratelimit|timeout).",
	}, []string{"provider", "op", "status"})
	m.ProviderDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "music_jam_provider_request_duration_seconds",
		Help:    "Outbound provider HTTP call latency by provider and op.",
		Buckets: providerBuckets,
	}, []string{"provider", "op"})
	m.YouTubeQuotaTrips = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "music_jam_youtube_quota_trips_total",
		Help: "Times the YouTube quota breaker opened, by kind (daily|transient).",
	}, []string{"kind"})
	m.GoroutinePanics = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "music_jam_goroutine_panics_total",
		Help: "Panics recovered in background goroutines, by call site.",
	}, []string{"where"})

	m.Registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.StoreSaveDuration, m.PublishDuration, m.ProviderRequests, m.ProviderDuration,
		m.YouTubeQuotaTrips, m.GoroutinePanics,
	)

	// Known label combinations exist at zero from the first scrape, so rate()
	// and absent() alerts see a series before the first event.
	for _, p := range Providers {
		for _, op := range ProviderOps {
			m.ProviderDuration.WithLabelValues(p, op)
			for _, s := range ProviderStatuses {
				m.ProviderRequests.WithLabelValues(p, op, s).Add(0)
			}
		}
	}
	for _, k := range []string{"daily", "transient"} {
		m.YouTubeQuotaTrips.WithLabelValues(k).Add(0)
	}
	for _, w := range SafeGoWheres {
		m.GoroutinePanics.WithLabelValues(w).Add(0)
	}
	panicCounter.Store(m.GoroutinePanics)
}

// ObserveStoreSave records one room store Save.
func (m *Metrics) ObserveStoreSave(d time.Duration) { m.StoreSaveDuration.Observe(d.Seconds()) }

// ObservePublish records one room channel publish.
func (m *Metrics) ObservePublish(d time.Duration) { m.PublishDuration.Observe(d.Seconds()) }

// ObserveProvider records one outbound provider call. Unknown provider, op or
// status values collapse to "other"/"error" so the label set stays bounded.
func (m *Metrics) ObserveProvider(provider, op, status string, d time.Duration) {
	provider, op, status = clamp(provider, Providers, "other"), clamp(op, ProviderOps, "other"), clamp(status, ProviderStatuses, "error")
	m.ProviderRequests.WithLabelValues(provider, op, status).Inc()
	m.ProviderDuration.WithLabelValues(provider, op).Observe(d.Seconds())
}

// YouTubeQuotaTrip counts the breaker opening (kind: daily|transient).
func (m *Metrics) YouTubeQuotaTrip(kind string) {
	m.YouTubeQuotaTrips.WithLabelValues(clamp(kind, []string{"daily", "transient"}, "transient")).Inc()
}

// RegisterYouTubeQuotaGauge exposes music_jam_youtube_quota_open: 1 while the
// breaker is open, read from the callback at scrape time.
func (m *Metrics) RegisterYouTubeQuotaGauge(open func() bool) {
	m.Registry.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "music_jam_youtube_quota_open",
		Help: "1 while the YouTube quota circuit breaker is open, else 0.",
	}, func() float64 {
		if open() {
			return 1
		}
		return 0
	}))
}

func clamp(v string, allowed []string, fallback string) string {
	for _, a := range allowed {
		if v == a {
			return v
		}
	}
	return fallback
}

// SafeGo runs fn in a goroutine that recovers a panic: it logs
// goroutine_panic (where, panic value, trimmed stack) and counts it under
// music_jam_goroutine_panics_total{where}. A panic in a background goroutine
// would otherwise kill the whole process, rooms and all.
func SafeGo(where string, fn func()) {
	go func() {
		defer RecoverPanic(where)
		fn()
	}()
}

// RecoverPanic is the deferred half of SafeGo, for goroutines that already
// have their own defers: put `defer obs.RecoverPanic("where")` first.
func RecoverPanic(where string) {
	r := recover()
	if r == nil {
		return
	}
	stack := string(debug.Stack())
	if len(stack) > 2048 {
		stack = stack[:2048]
	}
	slog.Error("goroutine_panic", "where", where, "panic", panicString(r), "stack", stack)
	if c := panicCounter.Load(); c != nil {
		c.WithLabelValues(where).Inc()
	}
}

func panicString(r any) string {
	switch v := r.(type) {
	case error:
		return v.Error()
	case string:
		return v
	}
	return "non-string panic"
}

// RegisterPoolStats exposes pgxpool.Stat() as gauges and counters read at
// scrape time.
func (m *Metrics) RegisterPoolStats(pool *pgxpool.Pool) {
	m.Registry.MustRegister(newPoolCollector(pool.Stat))
}

type poolCollector struct {
	stat         func() *pgxpool.Stat
	acquired     *prometheus.Desc
	idle         *prometheus.Desc
	total        *prometheus.Desc
	max          *prometheus.Desc
	acquireCount *prometheus.Desc
	acquireSecs  *prometheus.Desc
	emptyCount   *prometheus.Desc
}

func newPoolCollector(stat func() *pgxpool.Stat) *poolCollector {
	d := func(name, help string) *prometheus.Desc {
		return prometheus.NewDesc("music_jam_db_pool_"+name, help, nil, nil)
	}
	return &poolCollector{
		stat:         stat,
		acquired:     d("acquired_conns", "Connections currently checked out."),
		idle:         d("idle_conns", "Idle connections in the pool."),
		total:        d("total_conns", "Connections in the pool (acquired, idle, constructing)."),
		max:          d("max_conns", "Configured pool size limit."),
		acquireCount: d("acquire_total", "Cumulative successful connection acquires."),
		acquireSecs:  d("acquire_seconds_total", "Cumulative time spent acquiring connections."),
		emptyCount:   d("empty_acquire_total", "Acquires that had to wait because the pool had no idle connection."),
	}
}

func (c *poolCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range []*prometheus.Desc{c.acquired, c.idle, c.total, c.max, c.acquireCount, c.acquireSecs, c.emptyCount} {
		ch <- d
	}
}

func (c *poolCollector) Collect(ch chan<- prometheus.Metric) {
	s := c.stat()
	g, k := prometheus.GaugeValue, prometheus.CounterValue
	ch <- prometheus.MustNewConstMetric(c.acquired, g, float64(s.AcquiredConns()))
	ch <- prometheus.MustNewConstMetric(c.idle, g, float64(s.IdleConns()))
	ch <- prometheus.MustNewConstMetric(c.total, g, float64(s.TotalConns()))
	ch <- prometheus.MustNewConstMetric(c.max, g, float64(s.MaxConns()))
	ch <- prometheus.MustNewConstMetric(c.acquireCount, k, float64(s.AcquireCount()))
	ch <- prometheus.MustNewConstMetric(c.acquireSecs, k, s.AcquireDuration().Seconds())
	ch <- prometheus.MustNewConstMetric(c.emptyCount, k, float64(s.EmptyAcquireCount()))
}
