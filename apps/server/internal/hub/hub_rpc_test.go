package hub

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// HandleRPC is the transport-independent RPC dispatch (protocol.md): every method
// takes roomId from params and returns the resulting RoomState.
func TestHandleRPC_RoomRouting(t *testing.T) {
	h := NewHub(nil) // nil node: publish skipped in tests

	// join creates the room named by params, not a default
	res, err := h.HandleRPC("room.join", []byte(`{"roomId":"demo42","name":"probe"}`))
	if err != nil {
		t.Fatalf("room.join: %v", err)
	}
	var st queue.RoomState
	if err := json.Unmarshal(res, &st); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if st.RoomID != "demo42" {
		t.Fatalf("joined room = %q, want demo42", st.RoomID)
	}

	// queue.add routes to the same room and returns full RoomState with bumped version
	res, err = h.HandleRPC("queue.add", []byte(`{"roomId":"demo42","track":{"title":"Me at the zoo","artist":"jawed","sources":{"youtube":{"videoId":"jNQXAC9IVRw","confidence":1}},"addedBy":"probe"}}`))
	if err != nil {
		t.Fatalf("queue.add: %v", err)
	}
	if err := json.Unmarshal(res, &st); err != nil {
		t.Fatalf("unmarshal add result: %v", err)
	}
	if st.RoomID != "demo42" || len(st.Queue) != 1 || st.Version != 1 {
		t.Fatalf("add result = roomId %q len %d version %d, want demo42/1/1", st.RoomID, len(st.Queue), st.Version)
	}
	if st.NowPlayingID != st.Queue[0].ID {
		t.Fatalf("first add should auto-set nowPlaying")
	}

	// separate room is isolated
	res, err = h.HandleRPC("room.join", []byte(`{"roomId":"other","name":"x"}`))
	if err != nil {
		t.Fatalf("room.join other: %v", err)
	}
	if err := json.Unmarshal(res, &st); err != nil {
		t.Fatalf("unmarshal other: %v", err)
	}
	if st.RoomID != "other" || len(st.Queue) != 0 {
		t.Fatalf("room isolation broken: %q len %d", st.RoomID, len(st.Queue))
	}

	// remove returns RoomState too
	res, _ = h.HandleRPC("room.join", []byte(`{"roomId":"demo42","name":"probe"}`))
	_ = json.Unmarshal(res, &st)
	trackID := st.Queue[0].ID
	res, err = h.HandleRPC("queue.remove", []byte(`{"roomId":"demo42","trackId":"`+trackID+`"}`))
	if err != nil {
		t.Fatalf("queue.remove: %v", err)
	}
	if err := json.Unmarshal(res, &st); err != nil {
		t.Fatalf("unmarshal remove result: %v", err)
	}
	if len(st.Queue) != 0 || st.Version != 2 {
		t.Fatalf("remove result len %d version %d, want 0/2", len(st.Queue), st.Version)
	}

	// unknown method errors
	if _, err := h.HandleRPC("nope", []byte(`{}`)); err == nil {
		t.Fatalf("unknown method should error")
	}
}

func TestHandleRPC_AdvanceAfter(t *testing.T) {
	h := NewHub(nil)

	// Set up a room with 3 tracks
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"demo","name":"probe"}`))
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	// Add first track
	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 1","artist":"A1","sources":{},"addedBy":"u1"}}`))
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t1ID := st.Queue[0].ID

	// Add second track
	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 2","artist":"A2","sources":{},"addedBy":"u2"}}`))
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t2ID := st.Queue[1].ID

	// Add third track
	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 3","artist":"A3","sources":{},"addedBy":"u3"}}`))
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t3ID := st.Queue[2].ID

	// Initial NowPlayingID should be t1
	if st.NowPlayingID != t1ID {
		t.Fatalf("initial NowPlayingID should be %s, got %s", t1ID, st.NowPlayingID)
	}

	// Advance from t1 -> t2
	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"demo","afterId":"`+t1ID+`"}`))
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	if st.NowPlayingID != t2ID {
		t.Fatalf("after 1st advance, NowPlayingID should be %s, got %s", t2ID, st.NowPlayingID)
	}

	// Advance from t2 -> t3
	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"demo","afterId":"`+t2ID+`"}`))
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	if st.NowPlayingID != t3ID {
		t.Fatalf("after 2nd advance, NowPlayingID should be %s, got %s", t3ID, st.NowPlayingID)
	}

	// Advance from t3 (last track) -> clears NowPlayingID
	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"demo","afterId":"`+t3ID+`"}`))
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	if st.NowPlayingID != "" {
		t.Fatalf("advance past last track should clear NowPlayingID, got %s", st.NowPlayingID)
	}
}

func TestHandleRPC_QueueReorder(t *testing.T) {
	h := NewHub(nil)

	// Set up a room with 3 tracks
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"demo","name":"probe"}`))
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	// Add first track
	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 1","artist":"A1","sources":{},"addedBy":"u1"}}`))
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t1ID := st.Queue[0].ID

	// Add second track
	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 2","artist":"A2","sources":{},"addedBy":"u2"}}`))
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t2ID := st.Queue[1].ID

	// Add third track
	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 3","artist":"A3","sources":{},"addedBy":"u3"}}`))
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t3ID := st.Queue[2].ID

	// Move t3 to index 0
	res, err := h.HandleRPC("queue.reorder", []byte(`{"roomId":"demo","trackId":"`+t3ID+`","toIndex":0}`))
	if err != nil {
		t.Fatalf("queue.reorder: %v", err)
	}
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	if st.Queue[0].ID != t3ID {
		t.Fatalf("after reorder, queue[0] should be %s, got %s", t3ID, st.Queue[0].ID)
	}
	if st.Queue[1].ID != t1ID {
		t.Fatalf("after reorder, queue[1] should be %s, got %s", t1ID, st.Queue[1].ID)
	}
	if st.Queue[2].ID != t2ID {
		t.Fatalf("after reorder, queue[2] should be %s, got %s", t2ID, st.Queue[2].ID)
	}
	if st.Version != 4 {
		t.Fatalf("version should be 4, got %d", st.Version)
	}

	// NowPlayingID should not change (still t1)
	if st.NowPlayingID != t1ID {
		t.Fatalf("NowPlayingID should not change after reorder, got %s", st.NowPlayingID)
	}
}

func TestHandleRPC_TrackSearchNoSearcher(t *testing.T) {
	h := NewHub(nil) // no searcher configured

	res, err := h.HandleRPC("track.search", []byte(`{"query":"bohemian rhapsody"}`))
	if err != nil {
		t.Fatalf("track.search with no searcher should not error: %v", err)
	}

	var results []SearchResult
	if err := json.Unmarshal(res, &results); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("no searcher should return empty array, got %d results", len(results))
	}
}

func TestHandleRPC_TrackSearchWithSearcher(t *testing.T) {
	h := NewHub(nil)

	// Mock searcher that returns fixed results
	h.WithSearcher(func(ctx context.Context, query string, limit int) ([]SearchResult, error) {
		return []SearchResult{
			{
				Title:      "Bohemian Rhapsody",
				Artist:     "Queen",
				SpotifyURI: "spotify:track:abc123",
				ISRC:       "GBUM71029604",
				DurationMs: 354400,
				ArtworkURL: "https://example.com/image.jpg",
			},
		}, nil
	})

	res, err := h.HandleRPC("track.search", []byte(`{"query":"bohemian rhapsody"}`))
	if err != nil {
		t.Fatalf("track.search: %v", err)
	}

	var results []SearchResult
	if err := json.Unmarshal(res, &results); err != nil {
		t.Fatalf("unmarshal: %v", err)
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
	if r.SpotifyURI != "spotify:track:abc123" {
		t.Errorf("SpotifyURI = %q, want spotify:track:abc123", r.SpotifyURI)
	}
}
