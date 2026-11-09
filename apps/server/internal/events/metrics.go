package events

import "github.com/prometheus/client_golang/prometheus"

// Drop reasons for music_jam_events_dropped_total. A bounded enum: never input.
const (
	DropBufferFull = "buffer_full"
	DropDBError    = "db_error"
	DropDisabled   = "disabled"
)

// Metrics counts what the Writer persisted and what it had to throw away.
type Metrics struct {
	Written *prometheus.CounterVec
	Dropped *prometheus.CounterVec
}

// NewMetrics registers the counters on reg (nil registers nothing, for
// tests) and creates every known label at zero so rate() and absent() alerts
// see the series before the first event.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		Written: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "music_jam_events_written_total",
			Help: "Product events inserted into product_events, by event name.",
		}, []string{"name"}),
		Dropped: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "music_jam_events_dropped_total",
			Help: "Product events discarded, by reason (buffer_full|db_error|disabled).",
		}, []string{"reason"}),
	}
	if reg != nil {
		reg.MustRegister(m.Written, m.Dropped)
	}
	for _, n := range Names() {
		m.Written.WithLabelValues(n).Add(0)
	}
	for _, r := range []string{DropBufferFull, DropDBError, DropDisabled} {
		m.Dropped.WithLabelValues(r).Add(0)
	}
	return m
}
