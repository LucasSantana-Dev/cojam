package hub

import (
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
