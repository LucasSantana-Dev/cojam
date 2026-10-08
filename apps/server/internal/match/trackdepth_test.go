package match

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// Hand-written fixtures in the shapes MusicBrainz really returns: the search
// endpoint has first-release-date and a slim releases[] (no label-info), the
// MBID lookup adds relations[], label-info and tags.
const mbSearchFixture = `{
  "created": "2026-10-08T12:00:00.000Z",
  "count": 2,
  "offset": 0,
  "recordings": [
    {
      "id": "rec-milo",
      "score": 100,
      "title": "Recorde",
      "length": 179000,
      "first-release-date": "2024-03-15",
      "artist-credit": [{"name": "Milo J", "artist": {"id": "a1", "name": "Milo J"}}],
      "releases": [
        {"id": "r2", "title": "Recorde (single)", "date": "2024-03-15"},
        {"id": "r3", "title": "Compilation", "date": "2025-01-01"}
      ]
    },
    {
      "id": "rec-other",
      "score": 40,
      "title": "Recorde",
      "first-release-date": "1999",
      "releases": []
    }
  ]
}`

const mbLookupFixture = `{
  "id": "rec-milo",
  "title": "Recorde",
  "first-release-date": "2024-03-15",
  "releases": [
    {"id": "r3", "title": "Compilation", "date": "2025-01-01"},
    {"id": "r2", "title": "Recorde (single)", "date": "2024-03-15"}
  ],
  "relations": [
    {"type": "producer", "artist": {"name": "Bizarrap"}},
    {"type": "mix", "artist": {"name": "Some Engineer"}},
    {"type": "performance", "work": {"relations": [
      {"type": "composer", "artist": {"name": "Milo J"}},
      {"type": "lyricist", "artist": {"name": "Milo J"}}
    ]}},
    {"type": "producer", "artist": {"name": "Bizarrap"}}
  ],
  "tags": [
    {"count": 2, "name": "trap"},
    {"count": 9, "name": "latin hip hop"}
  ]
}`

type mbStub struct {
	mu      sync.Mutex
	queries []string // raw search "query" param, in order
	paths   []string
	lookup  int // status override for the lookup: 0 = 200
	uas     []string
	incs    []string
}

// mbServer routes search, ISRC and lookup requests to fixtures, shrinks the
// rate-limit interval, and clears the depth cache.
func mbServer(t *testing.T, search, isrc, lookup string) (*mbStub, func()) {
	t.Helper()
	st := &mbStub{}
	oldURL, oldInt := musicbrainzURL, mbMinInterval
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		st.mu.Lock()
		st.paths = append(st.paths, r.URL.Path)
		if q := r.URL.Query().Get("query"); q != "" {
			st.queries = append(st.queries, q)
		}
		lookupStatus := st.lookup
		st.uas = append(st.uas, r.Header.Get("User-Agent"))
		if inc := r.URL.Query().Get("inc"); inc != "" {
			st.incs = append(st.incs, r.URL.Path+"?inc="+inc)
		}
		st.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasPrefix(r.URL.Path, "/release/"):
			if r.URL.Query().Get("inc") != "labels" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			_, _ = w.Write([]byte(`{"id":"r2","label-info":[{"label":{"name":"Sony Music"}}]}`))
		case strings.HasPrefix(r.URL.Path, "/recording/"):
			// Real MusicBrainz rejects "labels" on a recording with a 400.
			if strings.Contains(r.URL.Query().Get("inc"), "labels") {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if lookupStatus != 0 {
				w.WriteHeader(lookupStatus)
				return
			}
			_, _ = w.Write([]byte(lookup))
		case strings.HasPrefix(r.URL.Path, "/isrc/"):
			_, _ = w.Write([]byte(isrc))
		default:
			_, _ = w.Write([]byte(search))
		}
	}))
	musicbrainzURL = srv.URL
	mbMinInterval = time.Millisecond
	depthCacheMu.Lock()
	depthCache = map[string]*TrackDepth{}
	depthCacheMu.Unlock()
	return st, func() {
		srv.Close()
		musicbrainzURL, mbMinInterval = oldURL, oldInt
	}
}

func TestTrackDepth_SearchThenLookup(t *testing.T) {
	st, done := mbServer(t, mbSearchFixture, `{}`, mbLookupFixture)
	defer done()

	d, err := FetchTrackDepth(context.Background(), "", "Recorde - Radio Edit", "Milo J")
	if err != nil {
		t.Fatalf("FetchTrackDepth: %v", err)
	}
	if d.ReleaseYear != 2024 {
		t.Errorf("ReleaseYear = %d, want 2024", d.ReleaseYear)
	}
	if d.Label != "Sony Music" {
		t.Errorf("Label = %q, want the earliest release's label", d.Label)
	}
	want := map[string]string{"producer": "Bizarrap", "mix": "Some Engineer", "composer": "Milo J", "lyricist": "Milo J"}
	got := map[string]string{}
	for _, c := range d.Credits {
		got[c.Role] = c.Name
	}
	for role, name := range want {
		if got[role] != name {
			t.Errorf("credit %s = %q, want %q (all: %+v)", role, got[role], name, d.Credits)
		}
	}
	if len(d.Credits) != 4 {
		t.Errorf("duplicate credit not collapsed: %+v", d.Credits)
	}
	if len(d.Tags) != 2 || d.Tags[0] != "latin hip hop" {
		t.Errorf("tags should be ordered by count, got %v", d.Tags)
	}
	if d.Source != "musicbrainz" {
		t.Errorf("Source = %q", d.Source)
	}

	// Query is a quoted Lucene phrase with the version suffix stripped.
	if len(st.queries) != 1 || st.queries[0] != `recording:"Recorde" AND artist:"Milo J"` {
		t.Errorf("query = %v", st.queries)
	}
	// Search then lookup by MBID with the inc= set.
	if len(st.paths) != 3 || st.paths[1] != "/recording/rec-milo" || st.paths[2] != "/release/r2" {
		t.Errorf("paths = %v", st.paths)
	}
	wantInc := "/recording/rec-milo?inc=" + strings.ReplaceAll(mbRecordingInc, "+", " ") // "+" decodes to space
	if st.incs[0] != wantInc || strings.Contains(mbRecordingInc, "labels") {
		t.Errorf("recording inc = %v", st.incs)
	}
	if len(st.uas) != 3 {
		t.Fatalf("uas = %v", st.uas)
	}
	for _, ua := range st.uas {
		if ua != "CoJam/1.0 ( https://cojam.lucassantana.tech )" {
			t.Errorf("User-Agent = %q", ua)
		}
	}
}

func TestTrackDepth_ISRCLookup(t *testing.T) {
	isrc := `{"isrc":"GBUM71029604","recordings":[{"id":"rec-milo","title":"Recorde","first-release-date":"2024-03-15","releases":[]}]}`
	st, done := mbServer(t, `{"recordings":[]}`, isrc, mbLookupFixture)
	defer done()

	d, err := FetchTrackDepth(context.Background(), "gbum71029604", "Recorde", "Milo J")
	if err != nil {
		t.Fatalf("FetchTrackDepth: %v", err)
	}
	if d.Label != "Sony Music" || d.ReleaseYear != 2024 {
		t.Errorf("got %+v", d)
	}
	if len(st.queries) != 0 {
		t.Errorf("ISRC hit must not fall through to search, got %v", st.queries)
	}
}

func TestTrackDepth_LowScoreHitIgnored(t *testing.T) {
	// The unquoted free-text query once returned an unrelated recording first.
	search := `{"recordings":[{"id":"rec-tony","score":35,"title":"Other","first-release-date":"1970","releases":[]}]}`
	_, done := mbServer(t, search, `{}`, `{}`)
	defer done()

	d, err := FetchTrackDepth(context.Background(), "", "Recorde", "Milo J")
	if err != nil {
		t.Fatalf("FetchTrackDepth: %v", err)
	}
	if d.ReleaseYear != 0 || d.Label != "" || len(d.Credits) != 0 {
		t.Errorf("low-score hit leaked into result: %+v", d)
	}
}

func TestTrackDepth_CachedAndLookupFailureNotCached(t *testing.T) {
	st, done := mbServer(t, mbSearchFixture, `{}`, mbLookupFixture)
	defer done()

	if _, err := FetchTrackDepth(context.Background(), "", "Recorde", "Milo J"); err != nil {
		t.Fatal(err)
	}
	if _, err := FetchTrackDepth(context.Background(), "", "Recorde", "Milo J"); err != nil {
		t.Fatal(err)
	}
	if len(st.paths) != 3 {
		t.Errorf("second call should be served from cache, paths = %v", st.paths)
	}

	// A failed lookup still returns the search data but is not cached.
	st.mu.Lock()
	st.lookup = http.StatusInternalServerError
	st.mu.Unlock()
	st.paths = nil
	d, err := FetchTrackDepth(context.Background(), "", "Other Song", "Milo J")
	if err != nil || d.ReleaseYear != 2024 || d.Label != "Sony Music" {
		t.Errorf("partial result expected, got %+v, %v", d, err)
	}
	_, _ = FetchTrackDepth(context.Background(), "", "Other Song", "Milo J")
	if len(st.paths) != 6 {
		t.Errorf("partial result must not be cached, paths = %v", st.paths)
	}
}

func TestTrackDepth_UpstreamErrorReturnedNotCached(t *testing.T) {
	oldURL, oldInt := musicbrainzURL, mbMinInterval
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer func() { srv.Close(); musicbrainzURL, mbMinInterval = oldURL, oldInt }()
	musicbrainzURL, mbMinInterval = srv.URL, time.Millisecond
	depthCacheMu.Lock()
	depthCache = map[string]*TrackDepth{}
	depthCacheMu.Unlock()

	if _, err := FetchTrackDepth(context.Background(), "", "T", "A"); err == nil {
		t.Fatal("expected error on 503")
	}
	_, _ = FetchTrackDepth(context.Background(), "", "T", "A")
	if calls != 2 {
		t.Errorf("error must not be cached, calls = %d", calls)
	}
}

func TestRecordingQuery(t *testing.T) {
	cases := []struct{ title, artist, want string }{
		{"Song - Radio Edit", "Artist", `recording:"Song" AND artist:"Artist"`},
		{"Song - Remastered 2011", "Artist", `recording:"Song" AND artist:"Artist"`},
		{"Song (2009 Remaster)", "Artist", `recording:"Song" AND artist:"Artist"`},
		{"Song - Live at Wembley", "Artist", `recording:"Song - Live at Wembley" AND artist:"Artist"`},
		{`Say "Hi" \ now`, "AC/DC", `recording:"Say \"Hi\" \\ now" AND artist:"AC/DC"`},
		{"Song", "Milo J feat. Other", `recording:"Song" AND artist:"Milo J"`},
		{"Song", "A, B", `recording:"Song" AND artist:"A"`},
	}
	for _, c := range cases {
		if got := recordingQuery(c.title, c.artist); got != c.want {
			t.Errorf("recordingQuery(%q, %q) = %s, want %s", c.title, c.artist, got, c.want)
		}
	}
	// The query survives URL encoding round trip.
	q := recordingQuery("A & B", "C")
	if v, _ := url.QueryUnescape(url.QueryEscape(q)); v != q {
		t.Errorf("round trip changed query")
	}
}

func TestWaitMusicBrainz_SpacesRequestsAndHonoursContext(t *testing.T) {
	old := mbMinInterval
	defer func() { mbMinInterval = old }()
	mbMinInterval = 40 * time.Millisecond
	mbMu.Lock()
	mbNext = time.Time{}
	mbMu.Unlock()

	start := time.Now()
	for i := 0; i < 3; i++ {
		if err := waitMusicBrainz(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if el := time.Since(start); el < 75*time.Millisecond {
		t.Errorf("3 calls should span 2 intervals, took %v", el)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	mbMinInterval = time.Second
	_ = waitMusicBrainz(context.Background()) // reserve a slot a second out
	if err := waitMusicBrainz(ctx); err == nil {
		t.Error("expected context error while waiting for a slot")
	}
}
