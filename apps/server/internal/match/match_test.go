package match

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// spotifyStub wires the package HTTP vars to a token server + a search handler,
// returning a cleanup that restores them. tokenHits counts token fetches.
func spotifyStub(t *testing.T, tokenHits *int32, searchJSON string, captureQuery *string) func() {
	t.Helper()
	oldID, oldSecret := spotifyClientID, spotifyClientSecret
	oldTok, oldSearch, oldClient := spotifyTokenURL, spotifySearchURL, spotifyClient
	oldCache := spotifyTokenCache

	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(tokenHits, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"tok","expires_in":3600,"token_type":"Bearer"}`))
	}))
	searchSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if captureQuery != nil {
			*captureQuery = r.URL.Query().Get("q")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(searchJSON))
	}))

	spotifyClientID, spotifyClientSecret = "id", "secret"
	spotifyTokenURL, spotifySearchURL = tokenSrv.URL, searchSrv.URL
	spotifyClient = http.DefaultClient
	spotifyTokenCache = &tokenCacheEntry{}

	return func() {
		tokenSrv.Close()
		searchSrv.Close()
		spotifyClientID, spotifyClientSecret = oldID, oldSecret
		spotifyTokenURL, spotifySearchURL, spotifyClient = oldTok, oldSearch, oldClient
		spotifyTokenCache = oldCache
	}
}

const spotifyOneTrack = `{"tracks":{"items":[{"id":"abc","name":"Bohemian Rhapsody","uri":"spotify:track:abc","artists":[{"name":"Queen"}]}]}}`

func TestResolveSpotify_ISRCAuthoritative(t *testing.T) {
	var hits int32
	var gotQuery string
	defer spotifyStub(t, &hits, spotifyOneTrack, &gotQuery)()

	ref, err := ResolveSpotify(context.Background(), "Bohemian Rhapsody", "Queen", "GBUM71029604")
	if err != nil {
		t.Fatalf("ResolveSpotify: %v", err)
	}
	if ref == nil || ref.TrackURI != "spotify:track:abc" {
		t.Fatalf("ref = %+v, want TrackURI spotify:track:abc", ref)
	}
	if ref.Confidence != 1.0 {
		t.Fatalf("ISRC match confidence = %v, want 1.0 (authoritative)", ref.Confidence)
	}
	if gotQuery != "isrc:GBUM71029604" {
		t.Fatalf("search query = %q, want isrc:GBUM71029604", gotQuery)
	}
}

func TestResolveSpotify_TitleArtistScored(t *testing.T) {
	var hits int32
	var gotQuery string
	defer spotifyStub(t, &hits, spotifyOneTrack, &gotQuery)()

	ref, err := ResolveSpotify(context.Background(), "Bohemian Rhapsody", "Queen", "")
	if err != nil {
		t.Fatalf("ResolveSpotify: %v", err)
	}
	if ref == nil || ref.TrackURI != "spotify:track:abc" {
		t.Fatalf("ref = %+v, want spotify:track:abc", ref)
	}
	if ref.Confidence < MinConfidence {
		t.Fatalf("confidence = %v, want >= %v", ref.Confidence, MinConfidence)
	}
	if gotQuery != "Bohemian Rhapsody Queen" {
		t.Fatalf("search query = %q, want title+artist", gotQuery)
	}
}

func TestResolveSpotify_NoResults(t *testing.T) {
	var hits int32
	defer spotifyStub(t, &hits, `{"tracks":{"items":[]}}`, nil)()

	ref, err := ResolveSpotify(context.Background(), "Nope", "Nobody", "")
	if err != nil {
		t.Fatalf("ResolveSpotify: %v", err)
	}
	if ref != nil {
		t.Fatalf("empty results should give nil ref, got %+v", ref)
	}
}

func TestResolveSpotify_BelowThreshold(t *testing.T) {
	var hits int32
	// Search returns a totally unrelated track; token overlap with the wanted
	// title+artist is 0, so it's rejected on the title/artist path.
	defer spotifyStub(t, &hits, `{"tracks":{"items":[{"id":"z","name":"Zzz Unrelated","uri":"spotify:track:z","artists":[{"name":"Other"}]}]}}`, nil)()

	ref, err := ResolveSpotify(context.Background(), "Bohemian Rhapsody", "Queen", "")
	if err != nil {
		t.Fatalf("ResolveSpotify: %v", err)
	}
	if ref != nil {
		t.Fatalf("below-threshold match should be nil, got %+v", ref)
	}
}

func TestResolveSpotify_TokenCached(t *testing.T) {
	var hits int32
	defer spotifyStub(t, &hits, spotifyOneTrack, nil)()

	for i := 0; i < 3; i++ {
		if _, err := ResolveSpotify(context.Background(), "Bohemian Rhapsody", "Queen", ""); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("token fetched %d times, want 1 (cached)", got)
	}
}

func TestNewCachedMatcher_HitDoesNotReinvoke(t *testing.T) {
	callCount := 0
	inner := func(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error) {
		callCount++
		return &queue.SourceRef{VideoID: "abc123", Confidence: 0.9}, nil
	}

	hitCount := 0
	missCount := 0
	onEvent := func(hit bool) {
		if hit {
			hitCount++
		} else {
			missCount++
		}
	}

	cached := NewCachedMatcher(inner, onEvent)
	ctx := context.Background()

	// First call: miss, calls inner
	result1, err := cached(ctx, "Song", "Artist", "ISRC123")
	if err != nil {
		t.Fatalf("first call failed: %v", err)
	}
	if callCount != 1 {
		t.Errorf("inner called %d times, want 1", callCount)
	}
	if result1.VideoID != "abc123" {
		t.Errorf("got VideoID %q, want abc123", result1.VideoID)
	}
	if missCount != 1 || hitCount != 0 {
		t.Errorf("after miss: hits=%d misses=%d, want 0 hits 1 miss", hitCount, missCount)
	}

	// Second call: hit, does not call inner
	result2, err := cached(ctx, "Song", "Artist", "ISRC123")
	if err != nil {
		t.Fatalf("second call failed: %v", err)
	}
	if callCount != 1 {
		t.Errorf("inner called %d times after cache hit, want 1", callCount)
	}
	if result2.VideoID != "abc123" {
		t.Errorf("got VideoID %q, want abc123", result2.VideoID)
	}
	if missCount != 1 || hitCount != 1 {
		t.Errorf("after hit: hits=%d misses=%d, want 1 hit 1 miss", hitCount, missCount)
	}
}

func TestNewCachedMatcher_ConcurrentAccess(t *testing.T) {
	callCount := int64(0)
	inner := func(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error) {
		atomic.AddInt64(&callCount, 1)
		return &queue.SourceRef{VideoID: "vid123", Confidence: 0.85}, nil
	}

	cached := NewCachedMatcher(inner, func(hit bool) {})
	ctx := context.Background()

	var wg sync.WaitGroup
	results := make(map[int]*queue.SourceRef)
	var mu sync.Mutex

	// Fire 10 concurrent goroutines with the same key
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			result, err := cached(ctx, "Same", "Track", "")
			if err != nil {
				t.Errorf("goroutine %d: %v", idx, err)
				return
			}
			mu.Lock()
			results[idx] = result
			mu.Unlock()
		}(i)
	}

	wg.Wait()

	// All should return the same result
	for i := 0; i < 10; i++ {
		if results[i] == nil {
			t.Errorf("result[%d] is nil", i)
			continue
		}
		if results[i].VideoID != "vid123" {
			t.Errorf("result[%d].VideoID = %q, want vid123", i, results[i].VideoID)
		}
	}

	// Inner should have been called only once (or a few times if the lock
	// permits concurrent entries, but definitely not 10 times)
	if callCount > 2 {
		t.Errorf("inner called %d times, want <= 2 (some concurrency is ok)", callCount)
	}
}

func TestNewCachedMatcher_MissCachesNilResults(t *testing.T) {
	callCount := 0
	inner := func(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error) {
		callCount++
		return nil, nil // No match found
	}

	hitCount := 0
	missCount := 0
	onEvent := func(hit bool) {
		if hit {
			hitCount++
		} else {
			missCount++
		}
	}

	cached := NewCachedMatcher(inner, onEvent)
	ctx := context.Background()

	// First call: miss
	result1, err := cached(ctx, "Unknown", "Artist", "")
	if err != nil {
		t.Fatalf("first call failed: %v", err)
	}
	if result1 != nil {
		t.Errorf("expected nil result, got %v", result1)
	}
	if callCount != 1 {
		t.Errorf("inner called %d times, want 1", callCount)
	}
	if missCount != 1 {
		t.Errorf("missed %d times, want 1", missCount)
	}

	// Second call: should hit the cache (cached nil result)
	result2, err := cached(ctx, "Unknown", "Artist", "")
	if err != nil {
		t.Fatalf("second call failed: %v", err)
	}
	if result2 != nil {
		t.Errorf("expected nil result on cache hit, got %v", result2)
	}
	if callCount != 1 {
		t.Errorf("inner called %d times after cache hit on nil, want 1", callCount)
	}
	if hitCount != 1 || missCount != 1 {
		t.Errorf("after cache hit on nil: hits=%d misses=%d, want 1 hit 1 miss", hitCount, missCount)
	}
}

func TestCalculateConfidence(t *testing.T) {
	tests := []struct {
		name      string
		query     string
		title     string
		expected  float64
		tolerance float64
	}{
		{
			name:      "perfect match",
			query:     "hello world",
			title:     "hello world song",
			expected:  1.0,
			tolerance: 0.01,
		},
		{
			name:      "partial match",
			query:     "hello world test",
			title:     "hello song",
			expected:  0.33,
			tolerance: 0.02,
		},
		{
			name:      "no match",
			query:     "hello world",
			title:     "goodbye stranger",
			expected:  0.0,
			tolerance: 0.01,
		},
		{
			name:      "case insensitive",
			query:     "Hello World",
			title:     "hello world song",
			expected:  1.0,
			tolerance: 0.01,
		},
		{
			name:      "single token match",
			query:     "test",
			title:     "test song",
			expected:  1.0,
			tolerance: 0.01,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			queryTokens := strings.Fields(strings.ToLower(tt.query))
			titleTokens := strings.Fields(strings.ToLower(tt.title))
			result := calculateConfidence(queryTokens, titleTokens)

			if diff := result - tt.expected; diff < -tt.tolerance || diff > tt.tolerance {
				t.Errorf("expected %.2f, got %.2f (diff: %.4f)", tt.expected, result, diff)
			}
		})
	}
}

// Spotify matcher tests below

func TestResolveSpotify_ErrNotConfigured(t *testing.T) {
	// Save old env state
	oldID := spotifyClientID
	oldSecret := spotifyClientSecret
	defer func() {
		spotifyClientID = oldID
		spotifyClientSecret = oldSecret
	}()

	// Unset credentials
	spotifyClientID = ""
	spotifyClientSecret = ""

	ref, err := ResolveSpotify(context.Background(), "Title", "Artist", "")
	if err != ErrNotConfigured {
		t.Errorf("expected ErrNotConfigured, got %v", err)
	}
	if ref != nil {
		t.Errorf("expected nil ref, got %v", ref)
	}
}

