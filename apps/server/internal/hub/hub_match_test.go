package hub

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// queue.add on a track WITHOUT a youtube source triggers async enrichment via
// the injected matcher; the enriched state gets a bumped version.
func TestQueueAdd_AsyncMatchEnrichment(t *testing.T) {
	resolved := make(chan struct{})
	h := NewHub(nil).WithMatcher(func(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error) {
		defer close(resolved)
		if title != "Song" || artist != "Band" {
			t.Errorf("matcher got %q/%q", title, artist)
		}
		return &queue.SourceRef{VideoID: "resolved-vid", Confidence: 0.82}, nil
	})

	res, err := h.HandleRPC("queue.add", []byte(`{"roomId":"m1","track":{"title":"Song","artist":"Band","sources":{},"addedBy":"x"}}`), "")
	if err != nil {
		t.Fatalf("queue.add: %v", err)
	}
	var st queue.RoomState
	_ = json.Unmarshal(res, &st)
	if st.Queue[0].Sources.YouTube != nil {
		t.Fatal("RPC result should return immediately, without waiting for enrichment")
	}

	select {
	case <-resolved:
	case <-time.After(2 * time.Second):
		t.Fatal("matcher never called")
	}

	// poll: enrichment applies asynchronously after the matcher returns
	deadline := time.Now().Add(2 * time.Second)
	for {
		res, _ = h.HandleRPC("room.join", []byte(`{"roomId":"m1","name":"check"}`), "")
		_ = json.Unmarshal(res, &st)
		yt := st.Queue[0].Sources.YouTube
		if yt != nil && yt.VideoID == "resolved-vid" && st.Version == 2 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("enrichment never applied: %+v version=%d", st.Queue[0].Sources, st.Version)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// tracks that already carry a youtube source are not re-resolved
func TestQueueAdd_SkipsMatcherWhenSourcePresent(t *testing.T) {
	called := false
	h := NewHub(nil).WithMatcher(func(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error) {
		called = true
		return nil, nil
	})
	_, err := h.HandleRPC("queue.add", []byte(`{"roomId":"m2","track":{"title":"S","artist":"B","sources":{"youtube":{"videoId":"v","confidence":1}},"addedBy":"x"}}`), "")
	if err != nil {
		t.Fatalf("queue.add: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	if called {
		t.Fatal("matcher must not run when youtube source already present")
	}
}

// Both YouTube and Spotify matchers can enrich independently in the same hub.
// This guards against the defect where Spotify matcher was trapped in the
// YouTube else-branch in main.go and never wired when YOUTUBE_API_KEY was set.
func TestQueueAdd_BothMatchers_Enrich(t *testing.T) {
	ytResolved := make(chan struct{})
	spotifyResolved := make(chan struct{})

	h := NewHub(nil).
		WithMatcher(func(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error) {
			defer close(ytResolved)
			return &queue.SourceRef{VideoID: "yt-vid-123", Confidence: 0.85}, nil
		}).
		WithSpotifyMatcher(func(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error) {
			defer close(spotifyResolved)
			return &queue.SourceRef{TrackURI: "spotify:track:abc123", Confidence: 0.90}, nil
		})

	// Add a track with no sources
	res, err := h.HandleRPC("queue.add", []byte(`{"roomId":"m3","track":{"title":"Test","artist":"Artist","sources":{},"addedBy":"x"}}`), "")
	if err != nil {
		t.Fatalf("queue.add: %v", err)
	}
	var st queue.RoomState
	_ = json.Unmarshal(res, &st)

	// Wait for both matchers to be invoked
	select {
	case <-ytResolved:
	case <-time.After(2 * time.Second):
		t.Fatal("youtube matcher never called")
	}
	select {
	case <-spotifyResolved:
	case <-time.After(2 * time.Second):
		t.Fatal("spotify matcher never called")
	}

	// Poll until enrichment applies (both sources present)
	deadline := time.Now().Add(3 * time.Second)
	for {
		res, _ = h.HandleRPC("room.join", []byte(`{"roomId":"m3","name":"check"}`), "")
		_ = json.Unmarshal(res, &st)
		yt := st.Queue[0].Sources.YouTube
		spotify := st.Queue[0].Sources.Spotify
		if yt != nil && yt.VideoID == "yt-vid-123" &&
			spotify != nil && spotify.TrackURI == "spotify:track:abc123" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("enrichment never completed: yt=%v, spotify=%v", yt, spotify)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
