package hub

import (
	"encoding/json"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// Play without positionMs after a pause resumes from the paused position.
func TestTransportPlayAfterPauseKeepsPosition(t *testing.T) {
	h := NewHub(nil).WithSync(true)
	h.HandleRPC("room.join", []byte(`{"roomId":"demo","name":"test"}`), "")
	res, _ := h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 1","artist":"A1","sources":{},"addedBy":"u1"}}`), "")
	st := &queue.RoomState{}
	json.Unmarshal(res, st)
	trackID := st.Queue[0].ID

	h.HandleRPC("transport.play", []byte(`{"roomId":"demo","trackId":"`+trackID+`","positionMs":0}`), "")
	h.HandleRPC("transport.pause", []byte(`{"roomId":"demo","positionMs":42000}`), "")

	res, err := h.HandleRPC("transport.play", []byte(`{"roomId":"demo"}`), "")
	if err != nil {
		t.Fatalf("transport.play: %v", err)
	}
	json.Unmarshal(res, st)
	if st.Transport.State != "playing" {
		t.Fatalf("state = %q, want playing", st.Transport.State)
	}
	if st.Transport.PositionMs != 42000 {
		t.Fatalf("positionMs = %d, want 42000 (resume, not restart)", st.Transport.PositionMs)
	}

	// An explicit positionMs of 0 still restarts.
	res, _ = h.HandleRPC("transport.play", []byte(`{"roomId":"demo","positionMs":0}`), "")
	json.Unmarshal(res, st)
	if st.Transport.PositionMs != 0 {
		t.Fatalf("explicit positionMs 0 = %d, want 0", st.Transport.PositionMs)
	}
}
