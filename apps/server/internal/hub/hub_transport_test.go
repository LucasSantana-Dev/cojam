package hub

import (
	"encoding/json"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// TestTransportPlay tests transport.play RPC
func TestTransportPlay(t *testing.T) {
	h := NewHub(nil)

	// Setup: join and add a track
	h.HandleRPC("room.join", []byte(`{"roomId":"demo","name":"test"}`))
	res, _ := h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 1","artist":"A1","sources":{},"addedBy":"u1"}}`))
	st := &queue.RoomState{}
	json.Unmarshal(res, st)
	trackID := st.Queue[0].ID

	// Test transport.play with trackId and positionMs
	res, err := h.HandleRPC("transport.play", []byte(`{"roomId":"demo","trackId":"`+trackID+`","positionMs":1000}`))
	if err != nil {
		t.Fatalf("transport.play: %v", err)
	}

	if err := json.Unmarshal(res, st); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if st.Transport == nil {
		t.Fatalf("transport should not be nil")
	}
	if st.Transport.State != "playing" {
		t.Fatalf("transport.state = %q, want playing", st.Transport.State)
	}
	if st.Transport.PositionMs != 1000 {
		t.Fatalf("transport.positionMs = %d, want 1000", st.Transport.PositionMs)
	}
	if st.Transport.UpdatedAtServerMs == 0 {
		t.Fatalf("transport.updatedAtServerMs should be non-zero")
	}
	if st.NowPlayingID != trackID {
		t.Fatalf("nowPlayingId should be set to %s", trackID)
	}

	// Test version bump
	if st.Version <= 1 {
		t.Fatalf("version should bump, got %d", st.Version)
	}
}

// TestTransportPlayWithoutTrackId tests transport.play without trackId
func TestTransportPlayWithoutTrackId(t *testing.T) {
	h := NewHub(nil)

	// Setup
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"demo","name":"test"}`))
	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 1","artist":"A1","sources":{},"addedBy":"u1"}}`))
	st := &queue.RoomState{}
	json.Unmarshal(res, st)
	firstTrackID := st.Queue[0].ID
	initialVersion := st.Version

	// Play without trackId (keeps current now playing)
	res, err := h.HandleRPC("transport.play", []byte(`{"roomId":"demo","positionMs":500}`))
	if err != nil {
		t.Fatalf("transport.play: %v", err)
	}

	json.Unmarshal(res, st)
	if st.Transport.State != "playing" {
		t.Fatalf("transport.state = %q, want playing", st.Transport.State)
	}
	if st.Transport.PositionMs != 500 {
		t.Fatalf("transport.positionMs = %d, want 500", st.Transport.PositionMs)
	}
	if st.NowPlayingID != firstTrackID {
		t.Fatalf("nowPlayingId should remain %s", firstTrackID)
	}
	if st.Version <= initialVersion {
		t.Fatalf("version should bump")
	}
}

// TestTransportPause tests transport.pause RPC
func TestTransportPause(t *testing.T) {
	h := NewHub(nil)

	// Setup and play
	h.HandleRPC("room.join", []byte(`{"roomId":"demo","name":"test"}`))
	res, _ := h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 1","artist":"A1","sources":{},"addedBy":"u1"}}`))
	st := &queue.RoomState{}
	json.Unmarshal(res, st)

	res, _ = h.HandleRPC("transport.play", []byte(`{"roomId":"demo","positionMs":1000}`))
	json.Unmarshal(res, st)
	playVersion := st.Version

	// Pause at position 2500
	res, err := h.HandleRPC("transport.pause", []byte(`{"roomId":"demo","positionMs":2500}`))
	if err != nil {
		t.Fatalf("transport.pause: %v", err)
	}

	json.Unmarshal(res, st)
	if st.Transport.State != "paused" {
		t.Fatalf("transport.state = %q, want paused", st.Transport.State)
	}
	if st.Transport.PositionMs != 2500 {
		t.Fatalf("transport.positionMs = %d, want 2500", st.Transport.PositionMs)
	}
	if st.Version <= playVersion {
		t.Fatalf("version should bump on pause")
	}
}

// TestTransportSeek tests transport.seek RPC
func TestTransportSeek(t *testing.T) {
	h := NewHub(nil)

	// Setup and play
	h.HandleRPC("room.join", []byte(`{"roomId":"demo","name":"test"}`))
	h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 1","artist":"A1","sources":{},"addedBy":"u1"}}`))

	res, _ := h.HandleRPC("transport.play", []byte(`{"roomId":"demo","positionMs":1000}`))
	st := &queue.RoomState{}
	json.Unmarshal(res, st)
	playState := st.Transport.State
	playVersion := st.Version

	// Seek to new position
	res, err := h.HandleRPC("transport.seek", []byte(`{"roomId":"demo","positionMs":3000}`))
	if err != nil {
		t.Fatalf("transport.seek: %v", err)
	}

	json.Unmarshal(res, st)
	if st.Transport.PositionMs != 3000 {
		t.Fatalf("transport.positionMs = %d, want 3000", st.Transport.PositionMs)
	}
	if st.Transport.State != playState {
		t.Fatalf("seek should preserve state %q, got %q", playState, st.Transport.State)
	}
	if st.Version <= playVersion {
		t.Fatalf("version should bump on seek")
	}
}

// TestSyncPing tests sync.ping RPC (read-only, no publish)
func TestSyncPing(t *testing.T) {
	h := NewHub(nil)

	// Setup and add a track to get version bumps
	h.HandleRPC("room.join", []byte(`{"roomId":"demo","name":"test"}`))
	res, _ := h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 1","artist":"A1","sources":{},"addedBy":"u1"}}`))
	st := &queue.RoomState{}
	json.Unmarshal(res, st)
	versionBeforePing := st.Version

	// Call sync.ping
	res, err := h.HandleRPC("sync.ping", []byte(`{}`))
	if err != nil {
		t.Fatalf("sync.ping: %v", err)
	}

	var pingResult map[string]int64
	if err := json.Unmarshal(res, &pingResult); err != nil {
		t.Fatalf("unmarshal ping result: %v", err)
	}

	if pingResult["serverNowMs"] <= 0 {
		t.Fatalf("serverNowMs should be positive, got %d", pingResult["serverNowMs"])
	}

	// Verify version didn't change (read-only)
	res, _ = h.HandleRPC("room.join", []byte(`{"roomId":"demo","name":"test"}`))
	json.Unmarshal(res, st)
	if st.Version != versionBeforePing {
		t.Fatalf("sync.ping should not bump version, changed from %d to %d", versionBeforePing, st.Version)
	}
}

// TestTransportNegativePosition tests clamping of negative positions
func TestTransportNegativePosition(t *testing.T) {
	h := NewHub(nil)

	h.HandleRPC("room.join", []byte(`{"roomId":"demo","name":"test"}`))
	h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 1","artist":"A1","sources":{},"addedBy":"u1"}}`))

	// Try to play with negative position
	res, err := h.HandleRPC("transport.play", []byte(`{"roomId":"demo","positionMs":-100}`))
	if err != nil {
		t.Fatalf("transport.play with negative position: %v", err)
	}

	st := &queue.RoomState{}
	json.Unmarshal(res, st)
	if st.Transport.PositionMs != 0 {
		t.Fatalf("negative positionMs should be clamped to 0, got %d", st.Transport.PositionMs)
	}
}

// TestTransportMissingRoom tests error handling for missing roomId
func TestTransportMissingRoom(t *testing.T) {
	h := NewHub(nil)

	// transport.play without roomId should error
	if _, err := h.HandleRPC("transport.play", []byte(`{"positionMs":1000}`)); err == nil {
		t.Fatalf("transport.play without roomId should error")
	}

	// transport.pause without roomId should error
	if _, err := h.HandleRPC("transport.pause", []byte(`{"positionMs":1000}`)); err == nil {
		t.Fatalf("transport.pause without roomId should error")
	}

	// transport.seek without roomId should error
	if _, err := h.HandleRPC("transport.seek", []byte(`{"positionMs":1000}`)); err == nil {
		t.Fatalf("transport.seek without roomId should error")
	}
}
