package match

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/hub"
)

// Concurrent identical cache misses spend one API call.
func TestSearchSingleflightCollapsesConcurrentMisses(t *testing.T) {
	t.Setenv("YOUTUBE_API_KEY", "fake-api-value")
	resetSearchCache()
	resetYouTubeQuota()
	var searches atomic.Int32
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/videos" {
			_, _ = w.Write([]byte(`{"items":[]}`))
			return
		}
		searches.Add(1)
		<-release // hold the first call so every caller piles up behind it
		_, _ = w.Write([]byte(`{"items":[{"id":{"videoId":"abc"},"snippet":{"title":"Song Artist"}}]}`))
	}))
	t.Cleanup(srv.Close)
	oldS, oldV := youtubeSearchURL, youtubeVideosURL
	youtubeSearchURL, youtubeVideosURL = srv.URL+"/search", srv.URL+"/videos"
	t.Cleanup(func() { youtubeSearchURL, youtubeVideosURL = oldS, oldV })

	const n = 12
	var wg sync.WaitGroup
	results := make([][]YouTubeCandidate, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// Different casing and a cancelled caller context: same flight.
			q := "Song Artist"
			if i%2 == 1 {
				q = "song artist"
			}
			ctx := context.Background()
			if i == 0 {
				c, cancel := context.WithCancel(ctx)
				defer cancel()
				ctx = c
			}
			results[i], errs[i] = searchYouTubeCached(ctx, q)
		}(i)
	}
	waitUntil(t, func() bool { return searches.Load() >= 1 })
	time.Sleep(30 * time.Millisecond) // let the rest join the flight
	close(release)
	wg.Wait()

	if got := searches.Load(); got != 1 {
		t.Fatalf("API searches = %d for %d concurrent identical queries, want 1", got, n)
	}
	for i := range results {
		if errs[i] != nil || len(results[i]) != 1 || results[i][0].VideoID != "abc" {
			t.Fatalf("caller %d: %+v err=%v", i, results[i], errs[i])
		}
	}
	// Callers get their own copy.
	results[0][0].VideoID = "mutated"
	if results[1][0].VideoID != "abc" {
		t.Fatal("callers share one slice")
	}
}

// A failing flight returns its error to every waiter and caches nothing.
func TestSearchSingleflightSharesErrors(t *testing.T) {
	searches := quotaServer(t, func() (int, string) { return 500, "" })
	var wg sync.WaitGroup
	errs := make([]error, 6)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = searchYouTubeCached(context.Background(), "boom")
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err == nil {
			t.Fatalf("caller %d got no error", i)
		}
	}
	if *searches < 1 || *searches > len(errs) {
		t.Fatalf("searches = %d", *searches)
	}
	if _, ok := searchL1("boom"); ok {
		t.Fatal("an error was cached")
	}
}

// With the breaker open, a query already in the persistent cache (L2, cold
// L1 after a deploy) still resolves without an API call; an uncached one is
// refused with the quota error.
func TestQuotaOutageServesL2WithoutAPICall(t *testing.T) {
	searches := quotaServer(t, func() (int, string) { return 429, prodDailyBody })
	st := newMemStore()
	withSearchStore(t, st)
	st.rows["persisted query"] = []YouTubeCandidate{{VideoID: "p1", Title: "Persisted Query", Confidence: 1}}

	if _, err := searchYouTubeCached(context.Background(), "trip it"); !errors.Is(err, hub.ErrQuotaExhausted) {
		t.Fatalf("err = %v, want quota", err)
	}
	before := *searches
	cands, err := searchYouTubeCached(context.Background(), "Persisted Query")
	if err != nil || len(cands) != 1 || cands[0].VideoID != "p1" {
		t.Fatalf("L2 hit during outage: %+v err=%v", cands, err)
	}
	if _, err := searchYouTubeCached(context.Background(), "never seen"); !errors.Is(err, hub.ErrQuotaExhausted) {
		t.Fatalf("uncached during outage: err = %v, want quota", err)
	}
	if *searches != before {
		t.Fatalf("API calls during the outage: %d, want 0", *searches-before)
	}
}

func waitUntil(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("timed out")
}

// PurgeEvery runs once at start, then on every tick, and stops with its context.
func TestPurgeEveryRunsPeriodicallyAndStops(t *testing.T) {
	var runs atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	var seen atomic.Int64
	go func() {
		defer close(done)
		PurgeEvery(ctx, 3*time.Millisecond, func(context.Context) (int64, error) {
			return int64(runs.Add(1)), nil
		}, func(rows int64, err error) {
			if err == nil {
				seen.Store(rows)
			}
		})
	}()
	waitUntil(t, func() bool { return runs.Load() >= 3 })
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("PurgeEvery did not stop on context cancel")
	}
	final := runs.Load()
	time.Sleep(15 * time.Millisecond)
	if runs.Load() != final {
		t.Fatal("purge kept running after shutdown")
	}
	if seen.Load() < 1 {
		t.Fatal("onDone never saw a result")
	}
}
