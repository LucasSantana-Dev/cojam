package hub

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// Radio tracks carry only title+artist, so refill must run the matchers for
// every appended track (as queue.add does); otherwise the room shows them
// unavailable.
func TestRadioRefillEnriches(t *testing.T) {
	h := NewHub(nil)
	h.WithSimilarProvider(func(ctx context.Context, artist, title string, limit int) ([]queue.TrackRef, error) {
		return []queue.TrackRef{
			{Title: "S1", Artist: "A"}, {Title: "S2", Artist: "B"}, {Title: "S3", Artist: "C"},
		}, nil
	})
	var mu sync.Mutex
	yt := map[string]bool{}
	sp := map[string]bool{}
	h.matcher = func(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error) {
		mu.Lock()
		yt[title] = true
		mu.Unlock()
		return &queue.SourceRef{VideoID: "v-" + title, Confidence: 0.9}, nil
	}
	h.spotifyMatcher = func(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error) {
		mu.Lock()
		sp[title] = true
		mu.Unlock()
		return &queue.SourceRef{TrackURI: "s-" + title, Confidence: 0.9}, nil
	}

	_, _ = h.HandleRPC("room.join", []byte(`{"roomId":"radio-enrich","name":"u1"}`), "")
	_, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"radio-enrich","enabled":true}`), "")
	h.refillRadio("radio-enrich", &queue.TrackRef{Title: "Seed", Artist: "X"})

	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		done := len(yt) == 3 && len(sp) == 3
		mu.Unlock()
		if done {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("enrichment missing: youtube=%v spotify=%v", yt, sp)
		}
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if yt["Seed"] {
		t.Error("the seed track must not be enriched")
	}
}
