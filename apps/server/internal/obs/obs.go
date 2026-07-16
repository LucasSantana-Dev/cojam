// Package obs holds the server's observability surface: prometheus metrics
// and the slog attribute conventions (method, room_id, duration_ms).
package obs

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

type Metrics struct {
	Registry          *prometheus.Registry
	RPCDuration       *prometheus.HistogramVec
	ConnectionsActive prometheus.Gauge
	MatchConfidence   prometheus.Histogram
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
	}
	reg.MustRegister(m.RPCDuration, m.ConnectionsActive, m.MatchConfidence)
	return m
}

// RegisterRoomsGauge exposes a live room count from the given callback.
func (m *Metrics) RegisterRoomsGauge(count func() float64) {
	m.Registry.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "music_jam_rooms_active",
		Help: "Rooms currently held in the hub.",
	}, count))
}

func (m *Metrics) ObserveRPC(method string, err error, d time.Duration) {
	status := "ok"
	if err != nil {
		status = "error"
	}
	m.RPCDuration.WithLabelValues(method, status).Observe(d.Seconds())
}

func (m *Metrics) ConnInc() { m.ConnectionsActive.Inc() }
func (m *Metrics) ConnDec() { m.ConnectionsActive.Dec() }

func (m *Metrics) ObserveMatchConfidence(c float64) { m.MatchConfidence.Observe(c) }
