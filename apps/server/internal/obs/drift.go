package obs

import (
	"math"
	"sync"

	"github.com/prometheus/client_golang/prometheus"
)

// Sync drift telemetry. Kept in its own file with lazy registration so it adds
// no field to Metrics and no line to obs.go: EnsureDrift is called when the
// telemetry handler is built and is idempotent per Metrics.

// DriftBuckets are in seconds and apply to the ABSOLUTE drift.
var DriftBuckets = []float64{0.25, 0.5, 1, 2, 5, 10, 30, 120}

// Bounded label enums. Request values never reach a label unless they are one
// of these, so a hostile client cannot create series.
var (
	DriftPlayers   = []string{"youtube", "spotify"}
	DriftPlatforms = []string{"mobile", "desktop"}
	driftHidden    = []string{"true", "false"}
)

// MaxDriftMs mirrors the client clamp (10 minutes).
const MaxDriftMs = 600000

type driftSeries struct {
	seconds *prometheus.HistogramVec
	samples *prometheus.CounterVec
}

var driftRegistry sync.Map // *Metrics -> *driftSeries

// EnsureDrift registers the drift series on m's registry once and initialises
// every label combination at zero.
func EnsureDrift(m *Metrics) {
	driftFor(m)
}

func driftFor(m *Metrics) *driftSeries {
	if v, ok := driftRegistry.Load(m); ok {
		return v.(*driftSeries)
	}
	d := &driftSeries{
		seconds: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "music_jam_sync_drift_seconds",
			Help:    "Absolute playback drift (actual minus expected position) sampled by browsers.",
			Buckets: DriftBuckets,
		}, []string{"player", "platform"}),
		samples: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "music_jam_sync_drift_samples_total",
			Help: "Playback drift samples received, by player, platform and tab visibility.",
		}, []string{"player", "platform", "hidden"}),
	}
	for _, p := range DriftPlayers {
		for _, pl := range DriftPlatforms {
			d.seconds.WithLabelValues(p, pl)
			for _, h := range driftHidden {
				d.samples.WithLabelValues(p, pl, h)
			}
		}
	}
	actual, loaded := driftRegistry.LoadOrStore(m, d)
	if loaded {
		return actual.(*driftSeries)
	}
	m.Registry.MustRegister(d.seconds, d.samples)
	return d
}

// SyncDrift records one sample. The caller has validated player and platform
// against DriftPlayers and DriftPlatforms.
func (m *Metrics) SyncDrift(player, platform string, hidden bool, driftMs float64) {
	d := driftFor(m)
	d.seconds.WithLabelValues(player, platform).Observe(math.Abs(driftMs) / 1000)
	h := "false"
	if hidden {
		h = "true"
	}
	d.samples.WithLabelValues(player, platform, h).Inc()
}
