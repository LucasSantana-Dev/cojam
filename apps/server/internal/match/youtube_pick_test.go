package match

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// ytServer fakes search.list and videos.list. durations maps videoId to the
// ISO8601 contentDetails duration; calls counts hits per path.
func ytServer(t *testing.T, items []string, durations map[string]string, calls map[string]int) {
	t.Helper()
	t.Setenv("YOUTUBE_API_KEY", "fake-api-value")
	resetSearchCache()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls[r.URL.Path]++
		switch r.URL.Path {
		case "/search":
			out := `{"items":[`
			for i, id := range items {
				if i > 0 {
					out += ","
				}
				out += `{"id":{"videoId":"` + id + `"},"snippet":{"title":"Tourner dans le vide Indila"}}`
			}
			_, _ = w.Write([]byte(out + `]}`))
		case "/videos":
			out := `{"items":[`
			first := true
			for id, d := range durations {
				if !first {
					out += ","
				}
				first = false
				out += `{"id":"` + id + `","contentDetails":{"duration":"` + d + `"}}`
			}
			_, _ = w.Write([]byte(out + `]}`))
		}
	}))
	t.Cleanup(srv.Close)
	oldS, oldV := youtubeSearchURL, youtubeVideosURL
	youtubeSearchURL, youtubeVideosURL = srv.URL+"/search", srv.URL+"/videos"
	t.Cleanup(func() { youtubeSearchURL, youtubeVideosURL = oldS, oldV })
}

func resetSearchCache() {
	searchCache.Lock()
	searchCache.m = map[string]searchEntry{}
	searchCache.Unlock()
}

func TestResolveYouTubeRejectsHourLongLoop(t *testing.T) {
	calls := map[string]int{}
	ytServer(t, []string{"loop", "song"}, map[string]string{"loop": "PT1H3M49S", "song": "PT3M2S"}, calls)
	ref, err := ResolveYouTube(queue.WithDuration(context.Background(), 169_000), "Tourner dans le vide", "Indila", "")
	if err != nil || ref == nil || ref.VideoID != "song" {
		t.Fatalf("ref = %+v err = %v, want the 3:02 video", ref, err)
	}
	// Different provider rounding (215.9 s vs 216.0 s) must share the one search.
	ref, _ = ResolveYouTube(queue.WithDuration(context.Background(), 170_000), "Tourner dans le vide", "Indila", "")
	if ref == nil || ref.VideoID != "song" {
		t.Fatalf("second duration: ref = %+v, want song", ref)
	}
	if calls["/search"] != 1 || calls["/videos"] != 1 {
		t.Fatalf("calls = %v, want one search and one batched videos.list shared across durations", calls)
	}
}

func TestResolveYouTubeUnknownDurationPrefersShortFallsBackToLong(t *testing.T) {
	ytServer(t, []string{"loop", "song"}, map[string]string{"loop": "PT1H3M49S", "song": "PT3M2S"}, map[string]int{})
	ref, _ := ResolveYouTube(context.Background(), "Tourner dans le vide", "Indila", "")
	if ref == nil || ref.VideoID != "song" {
		t.Fatalf("ref = %+v, want the short video preferred", ref)
	}
	// Only a long candidate (a DJ set): still playable, not rejected.
	ytServer(t, []string{"set"}, map[string]string{"set": "PT2H"}, map[string]int{})
	ref, _ = ResolveYouTube(context.Background(), "Tourner dans le vide", "Indila", "")
	if ref == nil || ref.VideoID != "set" {
		t.Fatalf("ref = %+v, want the long video as fallback", ref)
	}
}

func TestResolveYouTubeRejectsLiveStreams(t *testing.T) {
	ytServer(t, []string{"live", "song"}, map[string]string{"live": "P0D", "song": "PT3M2S"}, map[string]int{})
	ref, _ := ResolveYouTube(context.Background(), "Tourner dans le vide", "Indila", "")
	if ref == nil || ref.VideoID != "song" {
		t.Fatalf("ref = %+v, want the live stream skipped", ref)
	}
	ytServer(t, []string{"live"}, map[string]string{"live": "P0D"}, map[string]int{})
	if ref, _ := ResolveYouTube(context.Background(), "Tourner dans le vide", "Indila", ""); ref != nil {
		t.Fatalf("ref = %+v, a lone live stream is no match", ref)
	}
}

func TestDurationOKAndParse(t *testing.T) {
	cases := []struct {
		cand, cat int64
		want      bool
	}{
		{0, 169_000, true},
		{182_000, 169_000, true},
		{3_829_000, 169_000, false},
		{30_000, 169_000, false},
		{20 * 60_000, 0, true}, // unknown catalogue: the short preference lives in pickCandidate
	}
	for _, c := range cases {
		if got := durationOK(c.cand, c.cat); got != c.want {
			t.Errorf("durationOK(%d,%d) = %v, want %v", c.cand, c.cat, got, c.want)
		}
	}
	for in, want := range map[string]int64{
		"PT1H3M49S": 3_829_000, "P0D": 0, "PT3M2S": 182_000, "P1DT2H": 93_600_000, "garbage": 0,
	} {
		if got := parseISO8601DurationMs(in); got != want {
			t.Errorf("parse(%q) = %d, want %d", in, got, want)
		}
	}
}
