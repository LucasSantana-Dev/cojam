package match

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The API key rides the query string and a transport error embeds the URL.
// Neither the returned error (it reaches the match_miss line) nor the
// duration-lookup log may carry it.
func TestYouTubeErrorsNeverLeakTheAPIKey(t *testing.T) {
	canary := "canary" + "-" + "not-a-real-credential"
	t.Setenv("YOUTUBE_API_KEY", canary)
	resetSearchCache()

	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close() // connection refused: a *url.Error carrying the full URL

	oldS, oldV := youtubeSearchURL, youtubeVideosURL
	defer func() { youtubeSearchURL, youtubeVideosURL = oldS, oldV }()

	var buf bytes.Buffer
	oldLog := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	defer slog.SetDefault(oldLog)

	youtubeSearchURL = deadURL + "/search"
	_, err := YouTubeSearch("q")
	if err == nil || strings.Contains(err.Error(), canary) || strings.Contains(err.Error(), "key=") {
		t.Fatalf("search error leaks the key: %v", err)
	}

	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"items":[{"id":{"videoId":"a"},"snippet":{"title":"q"}}]}`))
	}))
	defer ok.Close()
	youtubeSearchURL, youtubeVideosURL = ok.URL, deadURL
	if _, err := YouTubeSearch("q"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "youtube_duration_lookup_failed") {
		t.Fatalf("expected the lookup failure to be logged: %q", buf.String())
	}
	if strings.Contains(buf.String(), canary) || strings.Contains(buf.String(), "key=") {
		t.Fatalf("log leaks the key: %s", buf.String())
	}
}
