package lyrics

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// lrclibStub wires an httptest server for BOTH LRCLIB endpoints and restores the
// originals after the test. /api/get returns responseJSON; /api/search returns an
// empty array by default (so no test ever reaches the real network via the
// get->search fallback). Use lrclibStubGetSearch to exercise the fallback.
func lrclibStub(t *testing.T, responseJSON string) func() {
	return lrclibStubGetSearch(t, responseJSON, "[]")
}

func lrclibStubGetSearch(t *testing.T, getJSON, searchJSON string) func() {
	t.Helper()
	oldGet, oldSearch := lrclibURL, lrclibSearchURL

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/search" {
			_, _ = w.Write([]byte(searchJSON))
			return
		}
		_, _ = w.Write([]byte(getJSON))
	}))

	lrclibURL = srv.URL + "/api/get"
	lrclibSearchURL = srv.URL + "/api/search"

	return func() {
		srv.Close()
		lrclibURL = oldGet
		lrclibSearchURL = oldSearch
	}
}

// Regression: a queue track with no/imprecise duration misses /api/get; the
// provider must fall back to /api/search rather than returning empty (and must
// never hit the real network).
func TestFetchLyrics_GetMissFallsBackToSearch(t *testing.T) {
	cleanup := lrclibStubGetSearch(t,
		`{"syncedLyrics":"","plainLyrics":""}`, // /api/get: miss
		`[{"syncedLyrics":"[00:01.00] found via search","plainLyrics":"found via search"}]`,
	)
	defer cleanup()

	got, err := FetchLyrics(context.Background(), "The Weeknd", "Blinding Lights", "", 0)
	if err != nil {
		t.Fatalf("FetchLyrics: %v", err)
	}
	if len(got.Synced) != 1 || got.Synced[0].Text != "found via search" {
		t.Fatalf("expected the /api/search hit, got %+v", got.Synced)
	}
}

func TestParseLRCTimestamp_SyncedLine(t *testing.T) {
	timeMs, text, err := parseLRCTimestamp("[00:12.34] Hello world")
	if err != nil {
		t.Fatalf("parseLRCTimestamp: %v", err)
	}
	if timeMs != 12340 {
		t.Fatalf("timeMs = %d, want 12340 (12.34 seconds)", timeMs)
	}
	if text != "Hello world" {
		t.Fatalf("text = %q, want 'Hello world'", text)
	}
}

func TestParseLRCTimestamp_WithMinutes(t *testing.T) {
	timeMs, text, err := parseLRCTimestamp("[01:45.67] Some lyrics")
	if err != nil {
		t.Fatalf("parseLRCTimestamp: %v", err)
	}
	// 1 min 45.67 sec = 60000 + 45670 = 105670 ms
	if timeMs != 105670 {
		t.Fatalf("timeMs = %d, want 105670", timeMs)
	}
	if text != "Some lyrics" {
		t.Fatalf("text = %q, want 'Some lyrics'", text)
	}
}

func TestParseLRCTimestamp_EmptyLine(t *testing.T) {
	_, text, err := parseLRCTimestamp("")
	if err != nil {
		t.Fatalf("parseLRCTimestamp: %v", err)
	}
	if text != "" {
		t.Fatalf("expected empty text, got %q", text)
	}
}

func TestParseLRCTimestamp_NoTimestamp(t *testing.T) {
	_, text, err := parseLRCTimestamp("Just plain text")
	if err != nil {
		t.Fatalf("parseLRCTimestamp: %v", err)
	}
	if text != "" {
		t.Fatalf("unformatted line should return empty text, got %q", text)
	}
}

func TestFetchLyrics_SyncedOnly(t *testing.T) {
	response := `{
  "syncedLyrics": "[00:12.34] First line\n[00:45.00] Second line",
  "plainLyrics": "",
  "duration": 180
}`
	defer lrclibStub(t, response)()

	lyrics, err := FetchLyrics(context.Background(), "Artist", "Title", "", 180000)
	if err != nil {
		t.Fatalf("FetchLyrics: %v", err)
	}
	if len(lyrics.Synced) != 2 {
		t.Fatalf("expected 2 synced lines, got %d", len(lyrics.Synced))
	}
	if lyrics.Synced[0].TimeMs != 12340 || lyrics.Synced[0].Text != "First line" {
		t.Fatalf("first line mismatch: %+v", lyrics.Synced[0])
	}
	if lyrics.Synced[1].TimeMs != 45000 || lyrics.Synced[1].Text != "Second line" {
		t.Fatalf("second line mismatch: %+v", lyrics.Synced[1])
	}
	if lyrics.Plain != "" {
		t.Fatalf("plain should be empty, got %q", lyrics.Plain)
	}
	if lyrics.Source != "lrclib" {
		t.Fatalf("source = %q, want lrclib", lyrics.Source)
	}
}

func TestFetchLyrics_PlainOnly(t *testing.T) {
	response := `{
  "syncedLyrics": "",
  "plainLyrics": "Verse 1\nVerse 2\nChorus",
  "duration": 180
}`
	defer lrclibStub(t, response)()

	lyrics, err := FetchLyrics(context.Background(), "Artist", "Title", "", 180000)
	if err != nil {
		t.Fatalf("FetchLyrics: %v", err)
	}
	if len(lyrics.Synced) != 0 {
		t.Fatalf("synced should be empty, got %d lines", len(lyrics.Synced))
	}
	if lyrics.Plain != "Verse 1\nVerse 2\nChorus" {
		t.Fatalf("plain mismatch: %q", lyrics.Plain)
	}
}

func TestFetchLyrics_EmptyResult(t *testing.T) {
	response := `{"syncedLyrics": "", "plainLyrics": "", "duration": 0}`
	defer lrclibStub(t, response)()

	lyrics, err := FetchLyrics(context.Background(), "Artist", "Title", "", 0)
	if err != nil {
		t.Fatalf("FetchLyrics: %v", err)
	}
	if len(lyrics.Synced) != 0 {
		t.Fatalf("synced should be empty")
	}
	if lyrics.Plain != "" {
		t.Fatalf("plain should be empty")
	}
	if lyrics.Source != "lrclib" {
		t.Fatalf("source should always be lrclib")
	}
}

func TestFetchLyrics_MissingArtist(t *testing.T) {
	response := `{"syncedLyrics": "", "plainLyrics": "", "duration": 0}`
	defer lrclibStub(t, response)()

	lyrics, err := FetchLyrics(context.Background(), "", "Title", "", 0)
	if err != nil {
		t.Fatalf("FetchLyrics: %v", err)
	}
	// Should gracefully return empty result without calling LRCLIB
	if len(lyrics.Synced) != 0 || lyrics.Plain != "" {
		t.Fatalf("expected graceful empty result for missing artist")
	}
}

func TestFetchLyrics_MissingTitle(t *testing.T) {
	response := `{"syncedLyrics": "", "plainLyrics": "", "duration": 0}`
	defer lrclibStub(t, response)()

	lyrics, err := FetchLyrics(context.Background(), "Artist", "", "", 0)
	if err != nil {
		t.Fatalf("FetchLyrics: %v", err)
	}
	// Should gracefully return empty result
	if len(lyrics.Synced) != 0 || lyrics.Plain != "" {
		t.Fatalf("expected graceful empty result for missing title")
	}
}

func TestFetchLyrics_SyncedAndPlain(t *testing.T) {
	response := `{
  "syncedLyrics": "[00:05.00] Line A\n[00:10.00] Line B",
  "plainLyrics": "Line A\nLine B\nLine C",
  "duration": 180
}`
	defer lrclibStub(t, response)()

	lyrics, err := FetchLyrics(context.Background(), "Artist", "Title", "Album", 180000)
	if err != nil {
		t.Fatalf("FetchLyrics: %v", err)
	}
	if len(lyrics.Synced) != 2 {
		t.Fatalf("expected 2 synced lines, got %d", len(lyrics.Synced))
	}
	if lyrics.Plain != "Line A\nLine B\nLine C" {
		t.Fatalf("plain mismatch")
	}
}

func TestNewCachedLyricsFetcher_CacheHit(t *testing.T) {
	callCount := 0
	inner := func(ctx context.Context, artist, title, album string, durationMs int) (*Lyrics, error) {
		callCount++
		return &Lyrics{
			Synced: []LyricLine{{TimeMs: 1000, Text: "test"}},
			Plain:  "plain test",
			Source: "lrclib",
		}, nil
	}

	cached := NewCachedLyricsFetcher(inner)

	// First call: miss
	result1, err := cached(context.Background(), "Artist", "Title", "Album", 180000)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	if callCount != 1 {
		t.Errorf("inner called %d times, want 1", callCount)
	}
	if len(result1.Synced) != 1 || result1.Synced[0].Text != "test" {
		t.Errorf("result1 mismatch: %+v", result1)
	}

	// Second call with same params: hit
	result2, err := cached(context.Background(), "Artist", "Title", "Album", 180000)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if callCount != 1 {
		t.Errorf("inner called %d times after cache hit, want 1", callCount)
	}
	if result2.Plain != "plain test" {
		t.Errorf("cached result mismatch: %+v", result2)
	}
}

func TestNewCachedLyricsFetcher_DifferentParams(t *testing.T) {
	callCount := 0
	inner := func(ctx context.Context, artist, title, album string, durationMs int) (*Lyrics, error) {
		callCount++
		return &Lyrics{Synced: []LyricLine{}, Plain: "", Source: "lrclib"}, nil
	}

	cached := NewCachedLyricsFetcher(inner)

	// First query
	_, _ = cached(context.Background(), "Artist1", "Title1", "Album1", 180000)
	// Different artist: should be a cache miss
	_, _ = cached(context.Background(), "Artist2", "Title1", "Album1", 180000)

	if callCount != 2 {
		t.Errorf("expected 2 calls (different keys), got %d", callCount)
	}
}
