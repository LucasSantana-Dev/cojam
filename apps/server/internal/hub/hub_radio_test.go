package hub

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

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
// triggers refill (SimilarProvider is called).
func TestRadioAutoRefillOnAdvance(t *testing.T) {
	h := NewHub(nil)

	// Stub similar provider returning 3 tracks
	var similarCallCount int32
	h.WithSimilarProvider(func(ctx context.Context, artist, title string, limit int) ([]queue.TrackRef, error) {
		atomic.AddInt32(&similarCallCount, 1)
		return []queue.TrackRef{
			{Title: "Similar 1", Artist: "Artist A"},
			{Title: "Similar 2", Artist: "Artist B"},
			{Title: "Similar 3", Artist: "Artist C"},
		}, nil
	})

	// Join, add 2 tracks
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"radio-test","name":"u1"}`))
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"radio-test","track":{"title":"Track 1","artist":"A1","sources":{},"addedBy":"u1"}}`))
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t1ID := st.Queue[0].ID

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"radio-test","track":{"title":"Track 2","artist":"A2","sources":{},"addedBy":"u1"}}`))
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t2ID := st.Queue[1].ID

	// Advance to t2
	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"radio-test","afterId":"`+t1ID+`"}`))
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	if st.NowPlayingID != t2ID {
		t.Fatalf("should have advanced to t2, got %s", st.NowPlayingID)
	}

	// Enable radio
	res, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"radio-test","enabled":true}`))
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	if !st.RadioEnabled {
		t.Fatalf("radio not enabled")
	}

	// Advance past t2 (last track) - should trigger refill
	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"radio-test","afterId":"`+t2ID+`"}`))
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	// After advancing past the last track, NowPlayingID becomes empty
	if st.NowPlayingID != "" {
		t.Fatalf("NowPlayingID should be empty after advancing past last, got %s", st.NowPlayingID)
	}

	// Wait for async refill to complete
	initialCallCount := atomic.LoadInt32(&similarCallCount)
	for i := 0; i < 50 && atomic.LoadInt32(&similarCallCount) == initialCallCount; i++ {
		time.Sleep(time.Millisecond * 10)
	}

	// SimilarProvider should have been called (refill was triggered)
	if got := atomic.LoadInt32(&similarCallCount); got != 1 {
		t.Errorf("SimilarProvider should be called once on refill, got %d calls", got)
	}
}

// TestRadioIdempotentRefill verifies that advancing past the last track
// with the same afterId (idempotent call) does not spawn multiple refills
func TestRadioIdempotentRefill(t *testing.T) {
	h := NewHub(nil)

	// Counter to track how many times similar is called (use atomic for thread-safe access)
	var callCount int32
	h.WithSimilarProvider(func(ctx context.Context, artist, title string, limit int) ([]queue.TrackRef, error) {
		atomic.AddInt32(&callCount, 1)
		return []queue.TrackRef{
			{Title: "S1", Artist: "A1"},
		}, nil
	})

	// Join, add 1 track, enable radio
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"radio-test","name":"u1"}`))
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"radio-test","track":{"title":"T1","artist":"A1","sources":{},"addedBy":"u1"}}`))
	_ = json.Unmarshal(res, st)
	t1ID := st.Queue[0].ID

	res, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"radio-test","enabled":true}`))
	_ = json.Unmarshal(res, st)

	// Advance past the only track
	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"radio-test","afterId":"`+t1ID+`"}`))
	_ = json.Unmarshal(res, st)

	// Wait for async refill to complete
	initialCallCount := atomic.LoadInt32(&callCount)
	for i := 0; i < 50 && atomic.LoadInt32(&callCount) == initialCallCount; i++ {
		time.Sleep(time.Millisecond * 10)
	}

	// Similar should have been called exactly once
	if got := atomic.LoadInt32(&callCount); got != 1 {
		t.Fatalf("SimilarProvider called %d times, want 1", got)
	}

	// Now advance again with the same afterId (idempotent - should be no-op)
	callCountBefore := atomic.LoadInt32(&callCount)
	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"radio-test","afterId":"`+t1ID+`"}`))
	_ = json.Unmarshal(res, st)

	// Give time for any async operations
	time.Sleep(time.Millisecond * 50)

	// SimilarProvider should NOT have been called again (idempotent, NowPlayingID already set)
	if got := atomic.LoadInt32(&callCount); got != callCountBefore {
		t.Fatalf("second identical advance should not trigger refill; SimilarProvider called %d times (was %d)", got, callCountBefore)
	}
}

// TestRadioDisabledNoRefill verifies that disabling radio after advance prevents refill
func TestRadioDisabledNoRefill(t *testing.T) {
	h := NewHub(nil)

	var callCount int32
	h.WithSimilarProvider(func(ctx context.Context, artist, title string, limit int) ([]queue.TrackRef, error) {
		atomic.AddInt32(&callCount, 1)
		return []queue.TrackRef{
			{Title: "S1", Artist: "A1"},
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

	// Give time for any async operations
	time.Sleep(time.Millisecond * 50)

	// If similar was never called (or called 0 times since radio is off), refill did not trigger
	if got := atomic.LoadInt32(&callCount); got > 0 {
		t.Fatalf("radio disabled should not trigger refill, got callCount=%d", got)
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
