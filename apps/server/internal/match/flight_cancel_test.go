package match

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A cancelled waiter returns at once even though the shared flight is still
// blocked on a slow upstream.
func TestSearchFlightCancelledWaiterReturns(t *testing.T) {
	t.Setenv("YOUTUBE_API_KEY", "fake-api-value")
	resetSearchCache()
	resetYouTubeQuota()
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/videos" {
			_, _ = w.Write([]byte(`{"items":[]}`))
			return
		}
		select {
		case started <- struct{}{}:
		default:
		}
		<-release
		_, _ = w.Write([]byte(`{"items":[]}`))
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) })
	oldS, oldV := youtubeSearchURL, youtubeVideosURL
	youtubeSearchURL, youtubeVideosURL = srv.URL+"/search", srv.URL+"/videos"
	t.Cleanup(func() { youtubeSearchURL, youtubeVideosURL = oldS, oldV })

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := searchYouTubeCached(ctx, "slow query")
		done <- err
	}()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("cancelled waiter stayed blocked on the shared flight")
	}
}
