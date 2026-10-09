package match

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/httpx"
	"github.com/LucasSantana-Dev/cojam/server/internal/hub"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

func TestNextQuotaResetIsLosAngelesMidnight(t *testing.T) {
	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name    string
		now     time.Time
		wantUTC string
	}{
		// PDT (UTC-7): midnight LA is 07:00 UTC.
		{"summer afternoon", time.Date(2026, 7, 15, 20, 0, 0, 0, time.UTC), "2026-07-16T07:00:00Z"},
		// PST (UTC-8): midnight LA is 08:00 UTC.
		{"winter afternoon", time.Date(2026, 1, 15, 20, 0, 0, 0, time.UTC), "2026-01-16T08:00:00Z"},
		// 06:59 UTC in summer is still the previous LA day (23:59 PDT).
		{"just before LA midnight", time.Date(2026, 7, 15, 6, 59, 0, 0, time.UTC), "2026-07-15T07:00:00Z"},
		// Exactly at the reset the next one is a full day away.
		{"at LA midnight", time.Date(2026, 7, 15, 7, 0, 0, 0, time.UTC), "2026-07-16T07:00:00Z"},
		// Spring forward 2026-03-08: the day before ends in PST, the reset after it is PDT.
		{"day before spring forward", time.Date(2026, 3, 7, 12, 0, 0, 0, la), "2026-03-08T08:00:00Z"},
		{"spring forward day", time.Date(2026, 3, 8, 12, 0, 0, 0, la), "2026-03-09T07:00:00Z"},
		// Fall back 2026-11-01: that LA day is 25 hours long.
		{"fall back day", time.Date(2026, 11, 1, 12, 0, 0, 0, la), "2026-11-02T08:00:00Z"},
	}
	for _, c := range cases {
		got := nextQuotaReset(c.now)
		if got.UTC().Format(time.RFC3339) != c.wantUTC {
			t.Errorf("%s: reset = %s, want %s", c.name, got.UTC().Format(time.RFC3339), c.wantUTC)
		}
		if h, m, s := got.In(la).Clock(); h != 0 || m != 0 || s != 0 {
			t.Errorf("%s: %v is not LA midnight", c.name, got.In(la))
		}
		if !got.After(c.now) {
			t.Errorf("%s: reset %v not after now", c.name, got)
		}
	}
}

func TestIsQuotaError(t *testing.T) {
	body := func(reason string) []byte {
		return []byte(`{"error":{"code":403,"errors":[{"reason":"` + reason + `"}]}}`)
	}
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"429", &httpx.StatusError{Code: 429}, true},
		{"403 quotaExceeded", &httpx.StatusError{Code: 403, Body: body("quotaExceeded")}, true},
		{"403 dailyLimitExceeded", &httpx.StatusError{Code: 403, Body: body("dailyLimitExceeded")}, true},
		{"403 rateLimitExceeded", &httpx.StatusError{Code: 403, Body: body("rateLimitExceeded")}, true},
		{"403 key problem", &httpx.StatusError{Code: 403, Body: body("forbidden")}, false},
		{"403 no body", &httpx.StatusError{Code: 403}, false},
		{"403 junk body", &httpx.StatusError{Code: 403, Body: []byte("<html>")}, false},
		{"500", &httpx.StatusError{Code: 500}, false},
		{"404", &httpx.StatusError{Code: 404}, false},
		{"wrapped", errors.Join(errors.New("x"), &httpx.StatusError{Code: 429}), true},
		{"other", errors.New("boom"), false},
	}
	for _, c := range cases {
		if got := isQuotaError(c.err); got != c.want {
			t.Errorf("%s: isQuotaError = %v, want %v", c.name, got, c.want)
		}
	}
}

// quotaServer fakes the YouTube API: search answers with status/body, and the
// number of search calls is counted.
func quotaServer(t *testing.T, status func() (int, string)) *int {
	t.Helper()
	t.Setenv("YOUTUBE_API_KEY", "fake-api-value")
	resetSearchCache()
	resetYouTubeQuota()
	t.Cleanup(resetYouTubeQuota)
	t.Cleanup(func() { quotaNow = time.Now })
	var mu sync.Mutex
	searches := new(int)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/videos" {
			_, _ = w.Write([]byte(`{"items":[]}`))
			return
		}
		mu.Lock()
		*searches++
		mu.Unlock()
		code, body := status()
		w.WriteHeader(code)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	oldS, oldV := youtubeSearchURL, youtubeVideosURL
	youtubeSearchURL, youtubeVideosURL = srv.URL+"/search", srv.URL+"/videos"
	t.Cleanup(func() { youtubeSearchURL, youtubeVideosURL = oldS, oldV })
	return searches
}

func TestQuotaBreakerTripsOn429AndSkipsCalls(t *testing.T) {
	searches := quotaServer(t, func() (int, string) { return 429, `{"error":{"code":429}}` })
	now := time.Date(2026, 7, 15, 20, 0, 0, 0, time.UTC)
	quotaNow = func() time.Time { return now }

	_, err := ResolveYouTube(context.Background(), "Song", "Artist", "")
	if !errors.Is(err, hub.ErrQuotaExhausted) {
		t.Fatalf("err = %v, want ErrQuotaExhausted", err)
	}
	until := YouTubeQuotaUntil()
	if want := time.Date(2026, 7, 16, 7, 0, 0, 0, time.UTC); !until.Equal(want) {
		t.Fatalf("until = %v, want %v", until, want)
	}
	if *searches != 1 {
		t.Fatalf("searches = %d, want 1", *searches)
	}

	// Open breaker: no more calls, for any query, and the error stays typed.
	for _, q := range []string{"Song", "Other"} {
		_, err = ResolveYouTube(context.Background(), q, "Artist", "")
		if !errors.Is(err, hub.ErrQuotaExhausted) {
			t.Fatalf("err = %v, want ErrQuotaExhausted", err)
		}
	}
	if *searches != 1 {
		t.Fatalf("searches = %d while the breaker is open, want still 1", *searches)
	}

	// Past the reset the breaker closes and the API is called again.
	now = until.Add(time.Second)
	if !YouTubeQuotaUntil().IsZero() {
		t.Fatal("breaker still open after the reset")
	}
	_, _ = ResolveYouTube(context.Background(), "Song", "Artist", "")
	if *searches != 2 {
		t.Fatalf("searches = %d after the reset, want 2", *searches)
	}
}

func TestQuotaBreakerTripsOn403QuotaButNotOnKeyError(t *testing.T) {
	status, body := 403, `{"error":{"errors":[{"reason":"forbidden"}]}}`
	searches := quotaServer(t, func() (int, string) { return status, body })

	_, err := ResolveYouTube(context.Background(), "Song", "Artist", "")
	if err == nil || errors.Is(err, hub.ErrQuotaExhausted) {
		t.Fatalf("a key error must fail without tripping the breaker, got %v", err)
	}
	if !YouTubeQuotaUntil().IsZero() {
		t.Fatal("breaker tripped on a non-quota 403")
	}

	body = `{"error":{"errors":[{"reason":"quotaExceeded"}]}}`
	_, err = ResolveYouTube(context.Background(), "Song", "Artist", "")
	if !errors.Is(err, hub.ErrQuotaExhausted) || YouTubeQuotaUntil().IsZero() {
		t.Fatalf("403 quotaExceeded must trip the breaker, err = %v", err)
	}
	if *searches != 2 {
		t.Fatalf("searches = %d, want 2", *searches)
	}
}

// Cached answers keep being served while the breaker is open.
func TestQuotaBreakerStillServesCache(t *testing.T) {
	fail := false
	quotaServer(t, func() (int, string) {
		if fail {
			return 429, ""
		}
		return 200, `{"items":[{"id":{"videoId":"abc"},"snippet":{"title":"Song Artist"}}]}`
	})
	if ref, err := ResolveYouTube(context.Background(), "Song", "Artist", ""); err != nil || ref == nil {
		t.Fatalf("warm-up: ref=%v err=%v", ref, err)
	}
	fail = true
	if _, err := ResolveYouTube(context.Background(), "Fresh", "Query", ""); !errors.Is(err, hub.ErrQuotaExhausted) {
		t.Fatalf("err = %v, want quota", err)
	}
	ref, err := ResolveYouTube(queue.WithDuration(context.Background(), 0), "Song", "Artist", "")
	if err != nil || ref == nil || ref.VideoID != "abc" {
		t.Fatalf("cached query during outage: ref=%v err=%v", ref, err)
	}
}
