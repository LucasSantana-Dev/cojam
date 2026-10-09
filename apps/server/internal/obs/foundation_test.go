package obs

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

func gatherNames(t *testing.T, m *Metrics) map[string]bool {
	t.Helper()
	mfs, err := m.Registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, mf := range mfs {
		out[mf.GetName()] = true
	}
	return out
}

func TestFoundationSeriesGathered(t *testing.T) {
	m := New()
	m.RegisterYouTubeQuotaGauge(func() bool { return false })
	names := gatherNames(t, m)
	for _, want := range []string{
		"go_goroutines", "process_cpu_seconds_total",
		"music_jam_store_save_duration_seconds", "music_jam_publish_duration_seconds",
		"music_jam_provider_requests_total", "music_jam_provider_request_duration_seconds",
		"music_jam_youtube_quota_trips_total", "music_jam_youtube_quota_open",
		"music_jam_goroutine_panics_total",
	} {
		if !names[want] {
			t.Errorf("series %s not gathered", want)
		}
	}
}

func TestObserveProviderClampsLabels(t *testing.T) {
	m := New()
	m.ObserveProvider("evil.example.com", "rm -rf", "weird", time.Millisecond)
	if got := testutil.ToFloat64(m.ProviderRequests.WithLabelValues("other", "other", "error")); got != 1 {
		t.Fatalf("clamped counter = %v, want 1", got)
	}
	m.ObserveProvider("youtube", "search", "quota", time.Millisecond)
	if got := testutil.ToFloat64(m.ProviderRequests.WithLabelValues("youtube", "search", "quota")); got != 1 {
		t.Fatalf("youtube search quota = %v, want 1", got)
	}
}

func TestQuotaGaugeFlips(t *testing.T) {
	m := New()
	open := false
	m.RegisterYouTubeQuotaGauge(func() bool { return open })
	read := func() float64 {
		mfs, _ := m.Registry.Gather()
		for _, mf := range mfs {
			if mf.GetName() == "music_jam_youtube_quota_open" {
				return mf.GetMetric()[0].GetGauge().GetValue()
			}
		}
		t.Fatal("gauge missing")
		return -1
	}
	if read() != 0 {
		t.Fatal("want 0 while closed")
	}
	open = true
	if read() != 1 {
		t.Fatal("want 1 while open")
	}
}

func TestSafeGoRecoversAndCounts(t *testing.T) {
	m := New()
	done := make(chan struct{})
	SafeGo("hub_enrich", func() {
		defer close(done)
		panic("boom")
	})
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("goroutine did not run")
	}
	deadline := time.Now().Add(2 * time.Second)
	for testutil.ToFloat64(m.GoroutinePanics.WithLabelValues("hub_enrich")) != 1 {
		if time.Now().After(deadline) {
			t.Fatal("panic not counted")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestPoolStatsCollector(t *testing.T) {
	// A lazily connecting pool: Stat() works without a database.
	pool, err := pgxpool.New(context.Background(), "postgres://u:p@127.0.0.1:1/db")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	m := New()
	m.RegisterPoolStats(pool)
	names := gatherNames(t, m)
	for _, want := range []string{"music_jam_db_pool_acquired_conns", "music_jam_db_pool_idle_conns", "music_jam_db_pool_total_conns",
		"music_jam_db_pool_max_conns", "music_jam_db_pool_acquire_total", "music_jam_db_pool_acquire_seconds_total", "music_jam_db_pool_empty_acquire_total"} {
		if !names[want] {
			t.Errorf("%s not gathered", want)
		}
	}
}
