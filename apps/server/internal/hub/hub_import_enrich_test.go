package hub

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// TestPlaylistImportEnrichesOnlyAddedTracks pins the partial-full fix: when an
// import only partially fits (queue near capacity), enrichment must run for
// exactly the tracks that were added, not for pre-existing queue entries.
// The old last-N heuristic (addedCount from len(tracks), ignoring remaining
// capacity) re-enriched already-queued tracks; this test fails on that code.
func TestPlaylistImportEnrichesOnlyAddedTracks(t *testing.T) {
	h := NewHub(nil) // no matcher yet: prefill must not enrich

	importTracks := func(titles []string) {
		t.Helper()
		tracks := make([]map[string]any, len(titles))
		for i, title := range titles {
			tracks[i] = map[string]any{"title": title, "artist": "A", "sources": map[string]any{}}
		}
		payload, _ := json.Marshal(map[string]any{
			"roomId":  "imp-enrich",
			"url":     "https://example.com/playlist",
			"addedBy": "u1",
			"tracks":  tracks,
		})
		if _, err := h.HandleRPC("playlist.import", payload, ""); err != nil {
			t.Fatalf("import %d tracks: %v", len(titles), err)
		}
	}

	batch := func(prefix string, n int, start int) []string {
		titles := make([]string, n)
		for i := range titles {
			titles[i] = fmt.Sprintf("%s-%d", prefix, start+i)
		}
		return titles
	}

	// Fill to 498/500 with source-less tracks (matcher still nil: no enrichment).
	importTracks(batch("Old", 200, 0))
	importTracks(batch("Old", 200, 200))
	importTracks(batch("Old", 98, 400))

	// Now attach the recording matcher: only enrichment from HERE matters.
	var mu sync.Mutex
	var enriched []string
	h.matcher = func(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error) {
		mu.Lock()
		enriched = append(enriched, title)
		mu.Unlock()
		return &queue.SourceRef{VideoID: "v-" + title, Confidence: 0.9}, nil
	}

	// Import 5 more; only 2 fit.
	importTracks(batch("New", 5, 0))

	// Wait for the two expected enrichment calls, then hold still to catch
	// spurious ones (old code would also enrich Old-495..Old-497).
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		n := len(enriched)
		mu.Unlock()
		if n >= 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("enrichment stalled: got %v", enriched)
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond)

	mu.Lock()
	got := append([]string(nil), enriched...)
	mu.Unlock()
	sort.Strings(got)
	want := []string{"New-0", "New-1"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("enriched %v; want exactly %v (over-enrichment touches pre-existing tracks)", got, want)
	}
}
