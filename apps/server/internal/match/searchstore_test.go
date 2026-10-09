package match

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/LucasSantana-Dev/cojam/server/internal/dbtest"
)

// memStore is an in-memory SearchStore with injectable failures.
type memStore struct {
	mu      sync.Mutex
	rows    map[string][]YouTubeCandidate
	ttls    map[string]time.Duration
	getErr  error
	putErr  error
	gets    int
	puts    int
	getHook func()
}

func newMemStore() *memStore {
	return &memStore{rows: map[string][]YouTubeCandidate{}, ttls: map[string]time.Duration{}}
}

func (m *memStore) Get(_ context.Context, key string) ([]YouTubeCandidate, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gets++
	if m.getErr != nil {
		return nil, false, m.getErr
	}
	c, ok := m.rows[key]
	return c, ok, nil
}

func (m *memStore) Put(_ context.Context, key string, c []YouTubeCandidate, ttl time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.puts++
	if m.putErr != nil {
		return m.putErr
	}
	m.rows[key], m.ttls[key] = c, ttl
	return nil
}

func withSearchStore(t *testing.T, s SearchStore) {
	t.Helper()
	SetSearchStore(s)
	t.Cleanup(func() { SetSearchStore(nil) })
}

func okSearch(t *testing.T, calls map[string]int) {
	t.Helper()
	ytServer(t, []string{"abc"}, map[string]string{"abc": "PT3M"}, calls)
}

// A restart (empty L1) is served from L2 without calling the API, and a miss
// writes through with the 30 day TTL.
func TestSearchStoreReadThroughAndWriteThrough(t *testing.T) {
	calls := map[string]int{}
	okSearch(t, calls)
	st := newMemStore()
	withSearchStore(t, st)

	if _, err := searchYouTubeCached(context.Background(), "Tourner Dans Le Vide Indila"); err != nil {
		t.Fatal(err)
	}
	if calls["/search"] != 1 || st.puts != 1 {
		t.Fatalf("calls=%v puts=%d, want one search and one write", calls, st.puts)
	}
	key := "tourner dans le vide indila"
	if ttl := st.ttls[key]; ttl != SearchStoreTTL {
		t.Fatalf("ttl = %v, want %v", ttl, SearchStoreTTL)
	}
	if got := st.rows[key]; len(got) != 1 || got[0].DurationMs != 180_000 {
		t.Fatalf("stored candidates = %+v, want one with its duration", got)
	}

	resetSearchCache() // a deploy wipes memory
	cands, err := searchYouTubeCached(context.Background(), "Tourner dans le vide Indila")
	if err != nil || len(cands) != 1 || cands[0].VideoID != "abc" || cands[0].DurationMs != 180_000 {
		t.Fatalf("cands=%+v err=%v", cands, err)
	}
	if calls["/search"] != 1 {
		t.Fatalf("search calls = %d after a restart, want still 1 (served from L2)", calls["/search"])
	}
	// L2 hits are promoted to L1: no second store read.
	gets := st.gets
	_, _ = searchYouTubeCached(context.Background(), "Tourner dans le vide Indila")
	if st.gets != gets {
		t.Fatal("L1 should answer after the L2 hit")
	}
}

func TestSearchStoreEmptyResultGetsShortTTL(t *testing.T) {
	ytServer(t, nil, nil, map[string]int{})
	st := newMemStore()
	withSearchStore(t, st)
	if _, err := searchYouTubeCached(context.Background(), "nothing here"); err != nil {
		t.Fatal(err)
	}
	if ttl := st.ttls["nothing here"]; ttl != SearchStoreEmptyTTL {
		t.Fatalf("empty result ttl = %v, want %v", ttl, SearchStoreEmptyTTL)
	}
}

// DB failures degrade to calling the API and never block or fail matching.
func TestSearchStoreFailuresDegradeToAPI(t *testing.T) {
	calls := map[string]int{}
	okSearch(t, calls)
	st := newMemStore()
	st.getErr = errors.New("db down")
	st.putErr = errors.New("db down")
	withSearchStore(t, st)

	cands, err := searchYouTubeCached(context.Background(), "some query")
	if err != nil || len(cands) != 1 {
		t.Fatalf("cands=%+v err=%v, want the API answer despite the DB failing", cands, err)
	}
	if calls["/search"] != 1 {
		t.Fatalf("search calls = %d, want 1", calls["/search"])
	}
}

// Errors are never cached, in either layer.
func TestSearchStoreDoesNotCacheErrors(t *testing.T) {
	quotaServer(t, func() (int, string) { return 500, "" })
	st := newMemStore()
	withSearchStore(t, st)
	if _, err := searchYouTubeCached(context.Background(), "q"); err == nil {
		t.Fatal("want an error")
	}
	if st.puts != 0 || len(st.rows) != 0 {
		t.Fatalf("an error reached the persistent cache: puts=%d", st.puts)
	}
	resetSearchCache()
}

// Results whose durations could not be fetched are not persisted for 30 days.
func TestSearchStoreSkipsIncompleteDurations(t *testing.T) {
	quotaServer(t, func() (int, string) {
		return 200, `{"items":[{"id":{"videoId":"abc"},"snippet":{"title":"Song Artist"}}]}`
	})
	// quotaServer answers /videos with an empty item list (a successful call),
	// so force the videos call to fail instead.
	old := youtubeVideosURL
	youtubeVideosURL = "http://127.0.0.1:1/videos"
	t.Cleanup(func() { youtubeVideosURL = old })
	st := newMemStore()
	withSearchStore(t, st)
	cands, err := searchYouTubeCached(context.Background(), "song artist")
	if err != nil || len(cands) != 1 {
		t.Fatalf("cands=%+v err=%v", cands, err)
	}
	if st.puts != 0 {
		t.Fatal("a result without durations must not be persisted")
	}
}

func TestSearchStoreOverlongKeySkipsDB(t *testing.T) {
	st := newMemStore()
	withSearchStore(t, st)
	long := fmt.Sprintf("%0*d", searchStoreMaxKey+1, 7)
	if _, ok := searchStoreGet(context.Background(), long); ok || st.gets != 0 {
		t.Fatal("overlong key must not touch the store")
	}
	searchStorePut(context.Background(), long, nil)
	if st.puts != 0 {
		t.Fatal("overlong key must not be written")
	}
}

// --- Postgres -------------------------------------------------------------

func pgStore(t *testing.T) (*PostgresSearchStore, *pgxpool.Pool) {
	t.Helper()
	pool := dbtest.Isolated(t) // skips without TEST_DATABASE_URL
	return NewPostgresSearchStore(pool), pool
}

func TestPostgresSearchStoreRoundTrip(t *testing.T) {
	st, _ := pgStore(t)
	ctx := context.Background()

	if _, found, err := st.Get(ctx, "missing"); err != nil || found {
		t.Fatalf("missing key: found=%v err=%v", found, err)
	}
	in := []YouTubeCandidate{
		{VideoID: "a", Title: "A", Confidence: 0.9, DurationMs: 215_000},
		{VideoID: "b", Title: "B", Confidence: 0.4, Live: true, Blocked: true},
	}
	if err := st.Put(ctx, "k", in, time.Hour); err != nil {
		t.Fatal(err)
	}
	got, found, err := st.Get(ctx, "k")
	if err != nil || !found || len(got) != 2 || got[0] != in[0] || got[1] != in[1] {
		t.Fatalf("got=%+v found=%v err=%v, want the stored candidates with durations", got, found, err)
	}

	// Upsert replaces and refreshes.
	if err := st.Put(ctx, "k", in[:1], time.Hour); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := st.Get(ctx, "k"); len(got) != 1 {
		t.Fatalf("upsert kept %d candidates, want 1", len(got))
	}

	// An empty result is a real, readable row (distinct from a miss).
	if err := st.Put(ctx, "empty", nil, time.Hour); err != nil {
		t.Fatal(err)
	}
	if got, found, err := st.Get(ctx, "empty"); err != nil || !found || len(got) != 0 {
		t.Fatalf("empty: got=%v found=%v err=%v", got, found, err)
	}
}

func TestPostgresSearchStoreExpiryAndPurge(t *testing.T) {
	st, pool := pgStore(t)
	ctx := context.Background()

	if err := st.Put(ctx, "stale", []YouTubeCandidate{{VideoID: "x"}}, time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE youtube_search_cache SET expires_at = now() - interval '1 minute' WHERE query_key = 'stale'`); err != nil {
		t.Fatal(err)
	}
	if _, found, err := st.Get(ctx, "stale"); err != nil || found {
		t.Fatalf("expired row must read as a miss: found=%v err=%v", found, err)
	}

	// Purge only drops rows expired for over a day.
	if _, err := pool.Exec(ctx, `UPDATE youtube_search_cache SET expires_at = now() - interval '2 days' WHERE query_key = 'stale'`); err != nil {
		t.Fatal(err)
	}
	_ = st.Put(ctx, "fresh", nil, time.Hour)
	n, err := st.Purge(ctx)
	if err != nil || n != 1 {
		t.Fatalf("purged %d (err %v), want 1", n, err)
	}
	if _, found, _ := st.Get(ctx, "fresh"); !found {
		t.Fatal("purge removed a live row")
	}
}

// End to end over Postgres: a "restart" is served from the table.
func TestSearchStorePostgresSurvivesRestart(t *testing.T) {
	st, _ := pgStore(t)
	calls := map[string]int{}
	okSearch(t, calls)
	withSearchStore(t, st)

	if _, err := searchYouTubeCached(context.Background(), "Persisted Query"); err != nil {
		t.Fatal(err)
	}
	resetSearchCache()
	cands, err := searchYouTubeCached(context.Background(), "persisted query")
	if err != nil || len(cands) != 1 || cands[0].DurationMs != 180_000 {
		t.Fatalf("cands=%+v err=%v", cands, err)
	}
	if calls["/search"] != 1 {
		t.Fatalf("search calls = %d, want 1", calls["/search"])
	}
}
