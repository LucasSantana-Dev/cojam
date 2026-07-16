package hub

import (
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// queue.add is capped at queue.MaxQueueSize so a client can't OOM the server by
// flooding a room. The (MaxQueueSize+1)th add is rejected.
func TestHandleRPC_QueueCap(t *testing.T) {
	h := NewHub(nil)
	add := []byte(`{"roomId":"cap","track":{"title":"t","artist":"a","sources":{},"addedBy":"u"}}`)

	for i := 0; i < queue.MaxQueueSize; i++ {
		if _, err := h.HandleRPC("queue.add", add); err != nil {
			t.Fatalf("add %d/%d should succeed: %v", i+1, queue.MaxQueueSize, err)
		}
	}

	// One past the cap is rejected, and the queue does not grow beyond the cap.
	if _, err := h.HandleRPC("queue.add", add); err == nil {
		t.Fatalf("add %d should be rejected (queue full)", queue.MaxQueueSize+1)
	}
}
