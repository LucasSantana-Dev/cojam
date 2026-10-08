package hub

import (
	"context"
	"encoding/json"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// TestRadioToggle verifies radio.set RPC can toggle RadioEnabled in room state
func TestRadioToggle(t *testing.T) {
	h := NewHub(nil)

	// Join room
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"radio-test","name":"u1"}`), "")
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	if st.RadioEnabled {
		t.Fatalf("radio should start disabled")
	}
	joinVersion := st.Version

	// Enable radio
	res, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"radio-test","enabled":true}`), "")
	_ = json.Unmarshal(res, st)

	if !st.RadioEnabled {
		t.Fatalf("radio.set(true) should enable, got %v", st.RadioEnabled)
	}
	// Version must bump or clients reject the publication (setState version guard).
	if st.Version != joinVersion+1 {
		t.Fatalf("radio.set(true) should bump version to %d, got %d", joinVersion+1, st.Version)
	}

	// Disable radio
	res, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"radio-test","enabled":false}`), "")
	_ = json.Unmarshal(res, st)

	if st.RadioEnabled {
		t.Fatalf("radio.set(false) should disable, got %v", st.RadioEnabled)
	}
	if st.Version != joinVersion+2 {
		t.Fatalf("radio.set(false) should bump version to %d, got %d", joinVersion+2, st.Version)
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
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"radio-test","name":"u1"}`), "")
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"radio-test","track":{"title":"Track 1","artist":"A1","sources":{},"addedBy":"u1"}}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t1ID := st.Queue[0].ID

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"radio-test","track":{"title":"Track 2","artist":"A2","sources":{},"addedBy":"u1"}}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t2ID := st.Queue[1].ID

	// Advance to t2
	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"radio-test","afterId":"`+t1ID+`"}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	if st.NowPlayingID != t2ID {
		t.Fatalf("should have advanced to t2, got %s", st.NowPlayingID)
	}

	// Enable radio
	res, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"radio-test","enabled":true}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	if !st.RadioEnabled {
		t.Fatalf("radio not enabled")
	}

	// Advance past t2 (last track) - should trigger refill
	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"radio-test","afterId":"`+t2ID+`"}`), "")
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

	// #175: refill into a drained room must start the FIRST refilled track
	// (Queue[0]: the 2 played entries live in History), not track 1 of history.
	room := mustRoom(t, h, "radio-test")
	deadline := time.Now().Add(2 * time.Second)
	for {
		room.mu.Lock()
		queueLen := len(room.State.Queue)
		nowPlaying := room.State.NowPlayingID
		firstRefilledID := ""
		if queueLen >= 1 {
			firstRefilledID = room.State.Queue[0].ID
		}
		room.mu.Unlock()

		if queueLen == 3 {
			if nowPlaying != firstRefilledID {
				t.Fatalf("refill should start first refilled track %s, got %s", firstRefilledID, nowPlaying)
			}
			if nowPlaying == t1ID {
				t.Fatalf("refill reset NowPlaying to history head %s", t1ID)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("refill never applied: queue len %d, nowPlaying %q", queueLen, nowPlaying)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestQueueAddIntoDrainedRoomStartsNewTrack pins #175 for the manual path: a
// queue.add into a drained room (history kept, NowPlayingID cleared) starts
// the new track, not track 1 of the already-played history.
func TestQueueAddIntoDrainedRoomStartsNewTrack(t *testing.T) {
	h := NewHub(nil)

	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"drain-test","name":"u1"}`), "")
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"drain-test","track":{"title":"T1","artist":"A1","sources":{},"addedBy":"u1"}}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t1ID := st.Queue[0].ID

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"drain-test","track":{"title":"T2","artist":"A2","sources":{},"addedBy":"u1"}}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t2ID := st.Queue[1].ID

	// Play through both tracks: queue drained, history kept (radio off).
	if _, err := h.HandleRPC("now_playing.advance", []byte(`{"roomId":"drain-test","afterId":"`+t1ID+`"}`), ""); err != nil {
		t.Fatalf("advance t1: %v", err)
	}
	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"drain-test","afterId":"`+t2ID+`"}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	if st.NowPlayingID != "" {
		t.Fatalf("queue should be drained, got NowPlayingID %s", st.NowPlayingID)
	}

	// Manual add into the drained room starts the new track.
	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"drain-test","track":{"title":"T3","artist":"A3","sources":{},"addedBy":"u1"}}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	newID := st.Queue[0].ID
	if st.NowPlayingID != newID {
		t.Fatalf("queue.add into drained room should start the new track %s, got %s", newID, st.NowPlayingID)
	}
	if st.NowPlayingID == t1ID {
		t.Fatalf("queue.add reset NowPlaying to history head %s", t1ID)
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
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"radio-test","name":"u1"}`), "")
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"radio-test","track":{"title":"T1","artist":"A1","sources":{},"addedBy":"u1"}}`), "")
	_ = json.Unmarshal(res, st)
	t1ID := st.Queue[0].ID

	res, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"radio-test","enabled":true}`), "")
	_ = json.Unmarshal(res, st)

	// Advance past the only track
	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"radio-test","afterId":"`+t1ID+`"}`), "")
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
	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"radio-test","afterId":"`+t1ID+`"}`), "")
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
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"radio-test","name":"u1"}`), "")
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"radio-test","track":{"title":"T1","artist":"A1","sources":{},"addedBy":"u1"}}`), "")
	_ = json.Unmarshal(res, st)
	t1ID := st.Queue[0].ID

	res, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"radio-test","enabled":true}`), "")
	_ = json.Unmarshal(res, st)

	// Disable before advance
	res, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"radio-test","enabled":false}`), "")
	_ = json.Unmarshal(res, st)

	// Advance should not trigger refill (radio is disabled)
	h.HandleRPC("now_playing.advance", []byte(`{"roomId":"radio-test","afterId":"`+t1ID+`"}`), "")

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
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"radio-test","name":"u1"}`), "")
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"radio-test","track":{"title":"T1","artist":"A1","sources":{},"addedBy":"u1"}}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t1ID := st.Queue[0].ID

	res, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"radio-test","enabled":true}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	// Advance should not crash even though similar is nil
	res, err := h.HandleRPC("now_playing.advance", []byte(`{"roomId":"radio-test","afterId":"`+t1ID+`"}`), "")
	if err != nil {
		t.Fatalf("advance with unconfigured radio should not error: %v", err)
	}
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	if st.NowPlayingID != "" {
		t.Fatalf("should have cleared NowPlayingID")
	}
}

// TestRadioRefillSeedIsCopied verifies the refill seed is a stable copy, not a
// pointer into the live queue: mutating the queue after the advance must not
// change what the refill searches for.
//
// The interleaving is forced deterministically: with GOMAXPROCS(1) the refill
// goroutine spawned by now_playing.advance stays parked until the test blocks,
// so the queue.reorder below is guaranteed to run before refillRadio evaluates
// seed.Artist/seed.Title. With the old pointer-into-slice capture the reorder
// rewrites the backing-array slot in place (Move shifts elements, Add would
// reallocate and mask the bug), and the provider sees the WRONG track; with
// the copy it must always see the original seed.
func TestRadioRefillSeedIsCopied(t *testing.T) {
	defer runtime.GOMAXPROCS(runtime.GOMAXPROCS(1))

	h := NewHub(nil)

	seedSeen := make(chan [2]string, 1)
	h.WithSimilarProvider(func(ctx context.Context, artist, title string, limit int) ([]queue.TrackRef, error) {
		seedSeen <- [2]string{artist, title}
		return []queue.TrackRef{{Title: "Similar", Artist: "S"}}, nil
	})

	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"seed-test","name":"u1"}`), "")
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"seed-test","track":{"title":"First","artist":"A1","sources":{},"addedBy":"u1"}}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t1ID := st.Queue[0].ID

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"seed-test","track":{"title":"Second","artist":"A2","sources":{},"addedBy":"u1"}}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t2ID := st.Queue[1].ID

	if _, err := h.HandleRPC("radio.set", []byte(`{"roomId":"seed-test","enabled":true}`), ""); err != nil {
		t.Fatalf("radio.set: %v", err)
	}

	// Play through both tracks. The first advance starts t2; the second runs
	// the queue dry, capturing History[0] (t2) as the refill seed and
	// spawning the refill goroutine (parked under GOMAXPROCS(1)).
	if _, err := h.HandleRPC("now_playing.advance", []byte(`{"roomId":"seed-test","afterId":"`+t1ID+`"}`), ""); err != nil {
		t.Fatalf("advance t1: %v", err)
	}
	if _, err := h.HandleRPC("now_playing.advance", []byte(`{"roomId":"seed-test","afterId":"`+t2ID+`"}`), ""); err != nil {
		t.Fatalf("advance t2: %v", err)
	}

	// Mutate the room before the refill goroutine reads the seed: a new
	// track starts playing and the state moves on. The seed was copied out
	// of History[0] at advance time, so it must still read t2.
	if _, err := h.HandleRPC("queue.add", []byte(`{"roomId":"seed-test","track":{"title":"Intruder","artist":"X","sources":{},"addedBy":"u1"}}`), ""); err != nil {
		t.Fatalf("add: %v", err)
	}

	select {
	case got := <-seedSeen:
		if got != [2]string{"A2", "Second"} {
			t.Errorf("refill searched with mutated seed %v; want [A2 Second] (seed is a pointer into the live queue)", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("refill provider was never called")
	}
}

// radioAvailable is a server capability: false without a similar-tracks
// provider, true with one, and never persisted into the stored room.
func TestRadioAvailableCapability(t *testing.T) {
	h := NewHub(nil)
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"cap-a","name":"u1"}`), "")
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(res, &raw); err != nil {
		t.Fatal(err)
	}
	if string(raw["radioAvailable"]) != "false" {
		t.Fatalf("radioAvailable must be present and false without a provider, got %s", raw["radioAvailable"])
	}

	h.WithSimilarProvider(func(ctx context.Context, artist, title string, limit int) ([]queue.TrackRef, error) {
		return nil, nil
	})
	res, _ = h.HandleRPC("radio.set", []byte(`{"roomId":"cap-a","enabled":true}`), "")
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	if !st.RadioAvailable {
		t.Fatal("radioAvailable should be true once a similar provider is wired")
	}

	// The persisted copy must not carry the capability.
	saved, err := h.store.Load(context.Background(), "cap-a")
	if err != nil {
		t.Fatal(err)
	}
	if saved.RadioAvailable {
		t.Fatal("radioAvailable must not be persisted")
	}
}

func TestRadioTrackKey(t *testing.T) {
	cases := [][2]string{
		{"Song", "Song"},
		{"Song - 2011 Remaster", "Song"},
		{"Song (Live at X)", "Song"},
		{"Song (Remastered 2009) - Live", "Song"},
	}
	for _, c := range cases {
		if got := radioTrackKey("Artist", c[0]); got != "artist|"+"song" {
			t.Errorf("radioTrackKey(%q) = %q", c[0], got)
		}
	}
}

// TestRadioRefillSkipsPlayedAndQueued: Last.fm can return the seed's remaster
// or tracks already in History; the refill must append only fresh ones.
func TestRadioRefillSkipsPlayedAndQueued(t *testing.T) {
	h := NewHub(nil)
	var gotLimit int32
	h.WithSimilarProvider(func(ctx context.Context, artist, title string, limit int) ([]queue.TrackRef, error) {
		atomic.StoreInt32(&gotLimit, int32(limit))
		return []queue.TrackRef{
			{Title: "Seed Song - 2011 Remaster", Artist: "Seed Artist"},
			{Title: "Played Before", Artist: "Other"},
			{Title: "Fresh 1", Artist: "F"},
			{Title: "fresh 1 (Live)", Artist: "f"},
			{Title: "Fresh 2", Artist: "F"},
		}, nil
	})
	h.HandleRPC("room.join", []byte(`{"roomId":"dedup","name":"u1"}`), "")
	room := mustRoom(t, h, "dedup")
	room.mu.Lock()
	room.State.RadioEnabled = true
	room.State.History = []queue.HistoryEntry{
		{ID: "h1", Title: "Seed Song", Artist: "Seed Artist"},
		{ID: "h2", Title: "Played Before", Artist: "Other"},
	}
	room.mu.Unlock()

	h.refillRadio("dedup", &queue.TrackRef{Title: "Seed Song", Artist: "Seed Artist"})

	if got := atomic.LoadInt32(&gotLimit); got != radioCandidates {
		t.Errorf("limit = %d, want %d", got, radioCandidates)
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	var titles []string
	for _, q := range room.State.Queue {
		titles = append(titles, q.Title)
	}
	if len(titles) != 2 || titles[0] != "Fresh 1" || titles[1] != "Fresh 2" {
		t.Errorf("queue = %v, want [Fresh 1 Fresh 2]", titles)
	}
}
