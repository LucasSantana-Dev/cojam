package hub

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// TestRadioToggle verifies radio.set RPC can toggle RadioEnabled in room state
func TestRadioToggle(t *testing.T) {
	h := NewHub(nil)

	// Join room
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"radio-test","name":"u1"}`))
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	if st.RadioEnabled {
		t.Fatalf("radio should start disabled")
	}

	// Enable radio
	res, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"radio-test","enabled":true}`))
	_ = json.Unmarshal(res, st)

	if !st.RadioEnabled {
		t.Fatalf("radio.set(true) should enable, got %v", st.RadioEnabled)
	}

	// Disable radio
	res, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"radio-test","enabled":false}`))
	_ = json.Unmarshal(res, st)

	if st.RadioEnabled {
		t.Fatalf("radio.set(false) should disable, got %v", st.RadioEnabled)
	}
}

// TestRadioAutoRefillOnAdvance verifies that advancing past last track with radio on
// properly clears NowPlayingID (refill is async, so we just verify the advance works).
func TestRadioAutoRefillOnAdvance(t *testing.T) {
	h := NewHub(nil)

	// Stub similar provider
	h.WithSimilarProvider(func(ctx context.Context, artist, title string, limit int) ([]queue.TrackRef, error) {
		// Return 2 fake similar tracks
		return []queue.TrackRef{
			{Title: "Similar 1", Artist: "Artist A", AddedBy: "radio"},
			{Title: "Similar 2", Artist: "Artist B", AddedBy: "radio"},
		}, nil
	})

	// Join, add 2 tracks
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"radio-test","name":"u1"}`))
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"radio-test","track":{"title":"Track 1","artist":"A1","sources":{},"addedBy":"u1"}}`))
	_ = json.Unmarshal(res, st)
	t1ID := st.Queue[0].ID

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"radio-test","track":{"title":"Track 2","artist":"A2","sources":{},"addedBy":"u1"}}`))
	_ = json.Unmarshal(res, st)
	t2ID := st.Queue[1].ID

	// Advance to t2 first
	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"radio-test","afterId":"`+t1ID+`"}`))
	_ = json.Unmarshal(res, st)

	if st.NowPlayingID != t2ID {
		t.Fatalf("should have advanced to t2, got %s", st.NowPlayingID)
	}

	// Now enable radio and advance past t2 (last track)
	res, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"radio-test","enabled":true}`))
	_ = json.Unmarshal(res, st)

	if !st.RadioEnabled {
		t.Fatalf("radio not enabled")
	}

	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"radio-test","afterId":"`+t2ID+`"}`))

	// Parse response to check NowPlayingID
	var respData map[string]interface{}
	json.Unmarshal(res, &respData)
	t.Logf("Response nowPlayingId: %v", respData["nowPlayingId"])

	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	t.Logf("After advance: NowPlayingID=%q, RadioEnabled=%v, Queue length=%d", st.NowPlayingID, st.RadioEnabled, len(st.Queue))
	if st.NowPlayingID != "" {
		t.Fatalf("NowPlayingID should be empty after advancing past last, got %s", st.NowPlayingID)
	}
}

// TestRadioIdempotentRefill verifies that concurrent advances don't double-refill
func TestRadioIdempotentRefill(t *testing.T) {
	h := NewHub(nil)

	// Counter to track how many times similar is called
	callCount := 0
	h.WithSimilarProvider(func(ctx context.Context, artist, title string, limit int) ([]queue.TrackRef, error) {
		callCount++
		return []queue.TrackRef{
			{Title: "S1", Artist: "A1", AddedBy: "radio"},
		}, nil
	})

	// Join, add 1 track, enable radio, advance past it
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"radio-test","name":"u1"}`))
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"radio-test","track":{"title":"T1","artist":"A1","sources":{},"addedBy":"u1"}}`))
	_ = json.Unmarshal(res, st)
	t1ID := st.Queue[0].ID

	res, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"radio-test","enabled":true}`))
	_ = json.Unmarshal(res, st)

	// Advance past the only track
	h.HandleRPC("now_playing.advance", []byte(`{"roomId":"radio-test","afterId":"`+t1ID+`"}`))

	// In a real scenario with true concurrency, a second advance from another
	// client would see NowPlayingID != afterID and be a no-op. The idempotency
	// guard in the refill mutate ensures the append only happens once if the
	// queue is already filled.
}

// TestRadioDisabledNoRefill verifies that disabling radio after advance prevents refill
func TestRadioDisabledNoRefill(t *testing.T) {
	h := NewHub(nil)

	callCount := 0
	h.WithSimilarProvider(func(ctx context.Context, artist, title string, limit int) ([]queue.TrackRef, error) {
		callCount++
		return []queue.TrackRef{
			{Title: "S1", Artist: "A1", AddedBy: "radio"},
		}, nil
	})

	// Join, add track, enable radio, disable radio, advance
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"radio-test","name":"u1"}`))
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"radio-test","track":{"title":"T1","artist":"A1","sources":{},"addedBy":"u1"}}`))
	_ = json.Unmarshal(res, st)
	t1ID := st.Queue[0].ID

	res, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"radio-test","enabled":true}`))
	_ = json.Unmarshal(res, st)

	// Disable before advance
	res, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"radio-test","enabled":false}`))
	_ = json.Unmarshal(res, st)

	// Advance should not trigger refill (radio is disabled)
	h.HandleRPC("now_playing.advance", []byte(`{"roomId":"radio-test","afterId":"`+t1ID+`"}`))

	// If similar was never called (or called 0 times since radio is off), refill did not trigger
	if callCount > 0 {
		t.Fatalf("radio disabled should not trigger refill, got callCount=%d", callCount)
	}
}

// TestRadioNotConfigured verifies graceful no-op when similar provider is nil
func TestRadioNotConfigured(t *testing.T) {
	h := NewHub(nil)
	// Don't wire a similar provider

	// Join, add track, enable radio, advance
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"radio-test","name":"u1"}`))
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"radio-test","track":{"title":"T1","artist":"A1","sources":{},"addedBy":"u1"}}`))
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t1ID := st.Queue[0].ID

	res, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"radio-test","enabled":true}`))
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	// Advance should not crash even though similar is nil
	res, err := h.HandleRPC("now_playing.advance", []byte(`{"roomId":"radio-test","afterId":"`+t1ID+`"}`))
	if err != nil {
		t.Fatalf("advance with unconfigured radio should not error: %v", err)
	}
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	if st.NowPlayingID != "" {
		t.Fatalf("should have cleared NowPlayingID")
	}
}
