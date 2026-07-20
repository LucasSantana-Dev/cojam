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
	"github.com/LucasSantana-Dev/cojam/server/internal/spotifyauth"
)

// spotifyStub wires the spotifyauth package HTTP vars to a token server + a search handler,
// returning a cleanup that restores them. tokenHits counts token fetches.
func spotifyStub(t *testing.T, tokenHits *int32, searchJSON string, captureQuery *string) func() {
	t.Helper()
	oldID, oldSecret := spotifyauth.ClientID, spotifyauth.ClientSecret
	oldTok, oldClient := spotifyauth.TokenURL, spotifyauth.Client

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

	spotifyauth.ClientID, spotifyauth.ClientSecret = "id", "secret"
	spotifyauth.TokenURL = tokenSrv.URL
	spotifyauth.Client = http.DefaultClient
	spotifySearchURL = searchSrv.URL
	spotifyauth.ResetCache()

	return func() {
		tokenSrv.Close()
		searchSrv.Close()
		spotifyauth.ClientID, spotifyauth.ClientSecret = oldID, oldSecret
		spotifyauth.TokenURL, spotifyauth.Client = oldTok, oldClient
		spotifyauth.ResetCache()
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
	oldID := spotifyauth.ClientID
	oldSecret := spotifyauth.ClientSecret
	defer func() {
		spotifyauth.ClientID = oldID
		spotifyauth.ClientSecret = oldSecret
		spotifyauth.ResetCache()
	}()

	// Unset credentials
	spotifyauth.ClientID = ""
	spotifyauth.ClientSecret = ""
	spotifyauth.ResetCache()

	ref, err := ResolveSpotify(context.Background(), "Title", "Artist", "")
	if err != ErrNotConfigured {
		t.Errorf("expected ErrNotConfigured, got %v", err)
	}
	if ref != nil {
		t.Errorf("expected nil ref, got %v", ref)
	}
}

// SearchSpotify tests

func TestSearchSpotify_ReturnsMappedCandidates(t *testing.T) {
	var hits int32
	searchJSON := `{"tracks":{"items":[{"id":"abc","name":"Bohemian Rhapsody","uri":"spotify:track:abc","artists":[{"name":"Queen"}],"duration_ms":354400,"external_ids":{"isrc":"GBUM71029604"},"album":{"name":"A Night at the Opera","images":[{"url":"https://example.com/image.jpg"}]}}]}}`
	defer spotifyStub(t, &hits, searchJSON, nil)()

	results, err := SearchSpotify(context.Background(), "Bohemian Rhapsody Queen", 8)
	if err != nil {
		t.Fatalf("SearchSpotify: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	r := results[0]
	if r.Title != "Bohemian Rhapsody" {
		t.Errorf("Title = %q, want Bohemian Rhapsody", r.Title)
	}
	if r.Artist != "Queen" {
		t.Errorf("Artist = %q, want Queen", r.Artist)
	}
	if r.SpotifyURI != "spotify:track:abc" {
		t.Errorf("SpotifyURI = %q, want spotify:track:abc", r.SpotifyURI)
	}
	if r.ISRC != "GBUM71029604" {
		t.Errorf("ISRC = %q, want GBUM71029604", r.ISRC)
	}
	if r.DurationMs != 354400 {
		t.Errorf("DurationMs = %d, want 354400", r.DurationMs)
	}
	if r.ArtworkURL != "https://example.com/image.jpg" {
		t.Errorf("ArtworkURL = %q, want https://example.com/image.jpg", r.ArtworkURL)
	}
}

func TestSearchSpotify_EmptyOnNotConfigured(t *testing.T) {
	oldID := spotifyauth.ClientID
	oldSecret := spotifyauth.ClientSecret
	defer func() {
		spotifyauth.ClientID = oldID
		spotifyauth.ClientSecret = oldSecret
		spotifyauth.ResetCache()
	}()

	spotifyauth.ClientID = ""
	spotifyauth.ClientSecret = ""
	spotifyauth.ResetCache()

	results, err := SearchSpotify(context.Background(), "query", 8)
	if err != nil {
		t.Fatalf("SearchSpotify should not error when unconfigured: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("expected empty slice when unconfigured, got %d results", len(results))
	}
}

func TestSearchSpotify_EmptyOnZeroResults(t *testing.T) {
	var hits int32
	defer spotifyStub(t, &hits, `{"tracks":{"items":[]}}`, nil)()

	results, err := SearchSpotify(context.Background(), "no match", 8)
	if err != nil {
		t.Fatalf("SearchSpotify: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("expected empty slice for no results, got %d", len(results))
	}
}

// Deezer search tests

func TestSearchDeezer_MapsCandidates(t *testing.T) {
	oldURL := deezerSearchURL
	defer func() { deezerSearchURL = oldURL }()

	searchSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"title":"Bohemian Rhapsody","duration":354,"artist":{"name":"Queen"},"album":{"cover_medium":"https://example.com/deezer.jpg"}}]}`))
	}))
	defer searchSrv.Close()

	deezerSearchURL = searchSrv.URL

	results, err := SearchDeezer(context.Background(), "bohemian rhapsody", 8)
	if err != nil {
		t.Fatalf("SearchDeezer: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	r := results[0]
	if r.Title != "Bohemian Rhapsody" {
		t.Errorf("Title = %q, want Bohemian Rhapsody", r.Title)
	}
	if r.Artist != "Queen" {
		t.Errorf("Artist = %q, want Queen", r.Artist)
	}
	if r.Source != "deezer" {
		t.Errorf("Source = %q, want deezer", r.Source)
	}
	if r.DurationMs != 354000 {
		t.Errorf("DurationMs = %d, want 354000", r.DurationMs)
	}
	if r.ArtworkURL != "https://example.com/deezer.jpg" {
		t.Errorf("ArtworkURL = %q, want https://example.com/deezer.jpg", r.ArtworkURL)
	}
	if r.SpotifyURI != "" {
		t.Errorf("SpotifyURI should be empty, got %q", r.SpotifyURI)
	}
}

func TestSearchDeezer_EmptyOnZeroResults(t *testing.T) {
	oldURL := deezerSearchURL
	defer func() { deezerSearchURL = oldURL }()

	searchSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer searchSrv.Close()

	deezerSearchURL = searchSrv.URL

	results, err := SearchDeezer(context.Background(), "no match", 8)
	if err != nil {
		t.Fatalf("SearchDeezer: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("expected empty slice for no results, got %d", len(results))
	}
}

// SearchAll tests

func TestSearchAll_AggregatesDeezer(t *testing.T) {
	oldDeezerURL := deezerSearchURL
	defer func() { deezerSearchURL = oldDeezerURL }()

	searchSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"title":"Test","duration":200,"artist":{"name":"Artist"},"album":{"cover_medium":"https://example.com/test.jpg"}}]}`))
	}))
	defer searchSrv.Close()

	deezerSearchURL = searchSrv.URL

	results, err := SearchAll(context.Background(), "test query", 8)
	if err != nil {
		t.Fatalf("SearchAll: %v", err)
	}
	if len(results) < 1 {
		t.Fatalf("expected at least 1 result from Deezer, got %d", len(results))
	}

	found := false
	for _, r := range results {
		if r.Source == "deezer" && r.Title == "Test" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("Deezer result not found in aggregated results")
	}
}

func TestSearchAll_DedupesByNormalizedTitle(t *testing.T) {
	oldDeezerURL := deezerSearchURL
	oldSpotifyID, oldSpotifySecret := spotifyauth.ClientID, spotifyauth.ClientSecret
	oldTokenURL, oldSearchURL := spotifyauth.TokenURL, spotifySearchURL
	oldClient := spotifyauth.Client

	defer func() {
		deezerSearchURL = oldDeezerURL
		spotifyauth.ClientID, spotifyauth.ClientSecret = oldSpotifyID, oldSpotifySecret
		spotifyauth.TokenURL, spotifySearchURL = oldTokenURL, oldSearchURL
		spotifyauth.Client = oldClient
		spotifyauth.ResetCache()
	}()

	// Setup Deezer with no ISRC (real API behavior)
	deezerSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"title":"Bohemian Rhapsody","duration":354,"artist":{"name":"Queen"},"album":{"cover_medium":"https://example.com/d.jpg"}}]}`))
	}))
	defer deezerSrv.Close()

	// Setup Spotify returning same track but WITHOUT ISRC (so both use title-based dedup key)
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"tok","expires_in":3600,"token_type":"Bearer"}`))
	}))
	defer tokenSrv.Close()

	spotifySearchSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Same track, same title+artist, but no ISRC
		_, _ = w.Write([]byte(`{"tracks":{"items":[{"id":"abc","name":"Bohemian Rhapsody","uri":"spotify:track:abc","artists":[{"name":"Queen"}],"duration_ms":354000,"external_ids":{},"album":{"images":[{"url":"https://example.com/s.jpg"}]}}]}}`))
	}))
	defer spotifySearchSrv.Close()

	deezerSearchURL = deezerSrv.URL
	spotifyauth.ClientID = "id"
	spotifyauth.ClientSecret = "secret"
	spotifyauth.TokenURL = tokenSrv.URL
	spotifySearchURL = spotifySearchSrv.URL
	spotifyauth.Client = http.DefaultClient
	spotifyauth.ResetCache()

	results, err := SearchAll(context.Background(), "bohemian", 8)
	if err != nil {
		t.Fatalf("SearchAll: %v", err)
	}

	// Should dedupe to exactly 1 result (both use title-based key since neither has ISRC)
	if len(results) != 1 {
		t.Fatalf("expected exactly 1 deduplicated result, got %d", len(results))
	}

	// The surviving entry must have SpotifyURI from Spotify (merge prefers SpotifyURI)
	if results[0].SpotifyURI != "spotify:track:abc" {
		t.Errorf("expected SpotifyURI spotify:track:abc, got %q", results[0].SpotifyURI)
	}

	// Should also preserve title and artist
	if results[0].Title != "Bohemian Rhapsody" {
		t.Errorf("title = %q, want Bohemian Rhapsody", results[0].Title)
	}
	if results[0].Artist != "Queen" {
		t.Errorf("artist = %q, want Queen", results[0].Artist)
	}
}

// SimilarTracks tests

func lastfmStub(t *testing.T, responseJSON string) func() {
	t.Helper()
	oldAPIKey := lastfmAPIKey
	oldURL := lastfmURL

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(responseJSON))
	}))

	lastfmAPIKey = "test-api-key"
	lastfmURL = srv.URL

	return func() {
		srv.Close()
		lastfmAPIKey = oldAPIKey
		lastfmURL = oldURL
	}
}

func TestSimilarTracks_MappedFromLastfm(t *testing.T) {
	defer lastfmStub(t, `{"similartracks":{"track":[{"name":"Track 1","artist":{"name":"Artist A"}},{"name":"Track 2","artist":{"name":"Artist B"}}]}}`)()

	refs, err := SimilarTracks(context.Background(), "Queen", "Bohemian Rhapsody", 10)
	if err != nil {
		t.Fatalf("SimilarTracks: %v", err)
	}

	if len(refs) != 2 {
		t.Fatalf("expected 2 similar tracks, got %d", len(refs))
	}

	if refs[0].Title != "Track 1" || refs[0].Artist != "Artist A" {
		t.Errorf("track 0: got %q/%q, want Track 1/Artist A", refs[0].Title, refs[0].Artist)
	}
	if refs[1].Title != "Track 2" || refs[1].Artist != "Artist B" {
		t.Errorf("track 1: got %q/%q, want Track 2/Artist B", refs[1].Title, refs[1].Artist)
	}
}

func TestSimilarTracks_ErrNotConfigured(t *testing.T) {
	oldAPIKey := lastfmAPIKey
	defer func() { lastfmAPIKey = oldAPIKey }()

	lastfmAPIKey = ""

	_, err := SimilarTracks(context.Background(), "Queen", "Bohemian Rhapsody", 10)
	if err != ErrNotConfigured {
		t.Errorf("expected ErrNotConfigured, got %v", err)
	}
}

func TestSimilarTracks_EmptyOnZeroSimilar(t *testing.T) {
	defer lastfmStub(t, `{"similartracks":{"track":[]}}`)()

	refs, err := SimilarTracks(context.Background(), "Queen", "Bohemian Rhapsody", 10)
	if err != nil {
		t.Fatalf("SimilarTracks: %v", err)
	}

	if len(refs) != 0 {
		t.Fatalf("expected empty slice, got %d tracks", len(refs))
	}
}

func TestSimilarTracks_Non200Error(t *testing.T) {
	oldAPIKey := lastfmAPIKey
	oldURL := lastfmURL
	defer func() {
		lastfmAPIKey = oldAPIKey
		lastfmURL = oldURL
	}()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"Internal Server Error"}`))
	}))
	defer srv.Close()

	lastfmAPIKey = "test-key"
	lastfmURL = srv.URL

	_, err := SimilarTracks(context.Background(), "Queen", "Bohemian Rhapsody", 10)
	if err == nil {
		t.Errorf("expected error on non-200 status, got nil")
	}
}

// Track Depth tests (MusicBrainz)

func musicbrainzStub(t *testing.T, recordingJSON string) func() {
	t.Helper()
	oldURL := musicbrainzURL
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(recordingJSON))
	}))
	musicbrainzURL = srv.URL
	return func() {
		srv.Close()
		musicbrainzURL = oldURL
	}
}

func TestTrackDepth_FullDataWithCredits(t *testing.T) {
	defer musicbrainzStub(t, `{
		"isrcs": [{
			"recordings": [{
				"id": "rec-123",
				"title": "Bohemian Rhapsody",
				"release-credit": [{
					"release": {
						"title": "A Night at the Opera",
						"date": "1975-10-31",
						"label-info": [{
							"label": {
								"name": "EMI"
							}
						}]
					}
				}],
				"relationships": [
					{"type": "engineer", "artist": {"name": "John Deacon"}},
					{"type": "producer", "artist": {"name": "Roy Thomas Baker"}}
				],
				"tags": [
					{"count": 100, "name": "rock"},
					{"count": 80, "name": "progressive rock"}
				]
			}]
		}]
	}`)()

	depth, err := FetchTrackDepth(context.Background(), "GBUM71029604", "Bohemian Rhapsody", "Queen")
	if err != nil {
		t.Fatalf("TrackDepth: %v", err)
	}
	if depth == nil {
		t.Fatalf("TrackDepth: returned nil")
	}

	if len(depth.Credits) < 2 {
		t.Errorf("expected at least 2 credits, got %d", len(depth.Credits))
	}

	if depth.ReleaseYear != 1975 {
		t.Errorf("ReleaseYear = %d, want 1975", depth.ReleaseYear)
	}

	if depth.Label != "EMI" {
		t.Errorf("Label = %q, want EMI", depth.Label)
	}

	if len(depth.Tags) == 0 {
		t.Errorf("expected tags, got empty")
	}

	if depth.Source != "musicbrainz" {
		t.Errorf("Source = %q, want musicbrainz", depth.Source)
	}
}

func TestTrackDepth_NoDataFound(t *testing.T) {
	defer musicbrainzStub(t, `{
		"count": 1,
		"recordings": [{
			"id": "rec-123",
			"title": "Bohemian Rhapsody",
			"release-credit": [],
			"relationships": [],
			"tags": []
		}]
	}`)()

	depth, err := FetchTrackDepth(context.Background(), "", "Bohemian Rhapsody", "Queen")
	if err != nil {
		t.Fatalf("TrackDepth: %v", err)
	}

	if depth == nil {
		t.Fatalf("TrackDepth: returned nil on sparse data")
	}

	// Should return empty result with source
	if depth.Source != "musicbrainz" {
		t.Errorf("Source = %q, want musicbrainz", depth.Source)
	}
}

func TestTrackDepth_EmptyISRC(t *testing.T) {
	// Without ISRC, should try title/artist fallback (returns empty result gracefully)
	defer musicbrainzStub(t, `{
		"count": 1,
		"recordings": [{
			"id": "rec-123",
			"title": "Song",
			"release-credit": [],
			"relationships": [],
			"tags": []
		}]
	}`)()

	depth, err := FetchTrackDepth(context.Background(), "", "Title", "Artist")
	if err != nil {
		t.Fatalf("TrackDepth: %v", err)
	}

	if depth == nil {
		t.Fatalf("TrackDepth: returned nil on no ISRC")
	}

	// Should have source even with no data
	if depth.Source != "musicbrainz" {
		t.Errorf("Source = %q, want musicbrainz", depth.Source)
	}
}

// Last.fm enrichment tests

func TestFetchLastfmEnrichment_Success(t *testing.T) {
	defer lastfmStub(t, `{
		"track": {
			"name": "Bohemian Rhapsody",
			"artist": "Queen",
			"playcount": "9999",
			"listeners": "5555",
			"tags": {
				"tag": [
					{"name": "rock"},
					{"name": "classic rock"},
					{"name": "70s"}
				]
			}
		}
	}`)()

	enrich, err := FetchLastfmEnrichment(context.Background(), "Queen", "Bohemian Rhapsody")
	if err != nil {
		t.Fatalf("FetchLastfmEnrichment: %v", err)
	}

	if enrich.Source != "lastfm" {
		t.Errorf("Source = %q, want lastfm", enrich.Source)
	}
	if enrich.Playcount != 9999 {
		t.Errorf("Playcount = %d, want 9999", enrich.Playcount)
	}
	if enrich.Listeners != 5555 {
		t.Errorf("Listeners = %d, want 5555", enrich.Listeners)
	}
	if len(enrich.Tags) != 3 {
		t.Errorf("Tags count = %d, want 3", len(enrich.Tags))
	}
}

func TestFetchLastfmEnrichment_ErrNotConfigured(t *testing.T) {
	oldAPIKey := lastfmAPIKey
	defer func() { lastfmAPIKey = oldAPIKey }()

	lastfmAPIKey = ""

	_, err := FetchLastfmEnrichment(context.Background(), "Queen", "Bohemian Rhapsody")
	if err != ErrNotConfigured {
		t.Errorf("expected ErrNotConfigured, got %v", err)
	}
}

func TestFetchLastfmEnrichment_GracefulEmpty(t *testing.T) {
	defer lastfmStub(t, `{"track":{"name":"","artist":"","playcount":"","listeners":"","tags":{"tag":[]}}}`)()

	enrich, err := FetchLastfmEnrichment(context.Background(), "Queen", "Bohemian Rhapsody")
	if err != nil {
		t.Fatalf("FetchLastfmEnrichment: %v", err)
	}

	if enrich.Source != "lastfm" {
		t.Errorf("Source = %q, want lastfm", enrich.Source)
	}
	if enrich.Playcount != 0 {
		t.Errorf("Playcount = %d, want 0", enrich.Playcount)
	}
	if enrich.Listeners != 0 {
		t.Errorf("Listeners = %d, want 0", enrich.Listeners)
	}
	if len(enrich.Tags) != 0 {
		t.Errorf("Tags count = %d, want 0", len(enrich.Tags))
	}
}

func TestRankByProviders_PreferSpotify(t *testing.T) {
	results := []SearchCandidate{
		{Title: "A", Artist: "X", Source: "deezer"},
		{Title: "B", Artist: "Y", Source: "spotify", SpotifyURI: "spotify:track:b"},
		{Title: "C", Artist: "Z", Source: "deezer", SpotifyURI: "spotify:track:c"}, // dedup-merged entry
		{Title: "D", Artist: "W", Source: "deezer"},
	}

	ranked := RankByProviders(results, []string{"spotify"})

	want := []string{"B", "C", "A", "D"}
	if len(ranked) != len(want) {
		t.Fatalf("len = %d, want %d", len(ranked), len(want))
	}
	for i, title := range want {
		if ranked[i].Title != title {
			t.Errorf("ranked[%d].Title = %q, want %q", i, ranked[i].Title, title)
		}
	}
}

func TestRankByProviders_EmptyPreferKeepsOrder(t *testing.T) {
	results := []SearchCandidate{
		{Title: "A", Source: "deezer"},
		{Title: "B", Source: "spotify", SpotifyURI: "spotify:track:b"},
	}

	ranked := RankByProviders(results, nil)
	if ranked[0].Title != "A" || ranked[1].Title != "B" {
		t.Errorf("order changed with empty prefer: %q, %q", ranked[0].Title, ranked[1].Title)
	}
}

func TestRankByProviders_UnknownProviderIgnored(t *testing.T) {
	results := []SearchCandidate{
		{Title: "A", Source: "deezer"},
		{Title: "B", Source: "spotify", SpotifyURI: "spotify:track:b"},
	}

	ranked := RankByProviders(results, []string{"tidal"})
	if ranked[0].Title != "A" || ranked[1].Title != "B" {
		t.Errorf("unknown provider changed order: %q, %q", ranked[0].Title, ranked[1].Title)
	}
}

func TestRankByProviders_PreferDeezer(t *testing.T) {
	results := []SearchCandidate{
		{Title: "B", Source: "spotify", SpotifyURI: "spotify:track:b"},
		{Title: "A", Source: "deezer"},
	}

	ranked := RankByProviders(results, []string{"deezer"})
	if ranked[0].Title != "A" {
		t.Errorf("ranked[0].Title = %q, want A (deezer preferred)", ranked[0].Title)
	}
}
