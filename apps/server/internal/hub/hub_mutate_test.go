package hub

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

// saveCountingStore wraps a Store and counts Save calls so tests can prove
// no-op mutations skip persistence (issue #120).
type saveCountingStore struct {
	inner store.Store
	saves int32
}

func (s *saveCountingStore) Load(ctx context.Context, roomID string) (*queue.RoomState, error) {
	return s.inner.Load(ctx, roomID)
}

func (s *saveCountingStore) Save(ctx context.Context, state *queue.RoomState) error {
	atomic.AddInt32(&s.saves, 1)
	return s.inner.Save(ctx, state)
}

func (s *saveCountingStore) saveCount() int32 { return atomic.LoadInt32(&s.saves) }

// TestMutateNoopSkipsSave pins the no-op fast path: a mutating RPC whose
// closure leaves Version untouched performs no store write (nor a broadcast,
// which version-guarded clients would reject anyway), while real mutations
// keep saving exactly once and no-op RPCs still return the current state.
func TestMutateNoopSkipsSave(t *testing.T) {
	st := &saveCountingStore{inner: store.NewMemory()}
	h := NewHub(nil).WithStore(st)

	// Anonymous join on a fresh room assigns no host and changes nothing:
	// the only Save is GetOrCreateRoom persisting the fresh room.
	res, err := h.HandleRPC("room.join", []byte(`{"roomId":"noop","name":"u1"}`), "")
	if err != nil {
		t.Fatalf("room.join: %v", err)
	}
	var state queue.RoomState
	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("no-op join must still return room state: %v", err)
	}
	if got := st.saveCount(); got != 1 {
		t.Fatalf("no-op join led to %d saves, want 1 (room creation only)", got)
	}

	// A real mutation saves.
	res, err = h.HandleRPC("queue.add", []byte(`{"roomId":"noop","track":{"title":"T1","artist":"A1","sources":{},"addedBy":"u1"}}`), "")
	if err != nil {
		t.Fatalf("queue.add: %v", err)
	}
	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("unmarshal add: %v", err)
	}
	trackID := state.Queue[0].ID
	if got := st.saveCount(); got != 2 {
		t.Fatalf("queue.add led to %d total saves, want 2", got)
	}

	// Idempotent advance (NowPlayingID != afterId) is a no-op: no save.
	if _, err := h.HandleRPC("now_playing.advance", []byte(`{"roomId":"noop","afterId":"not-playing"}`), ""); err != nil {
		t.Fatalf("advance: %v", err)
	}

	// Reorder to the current index is a no-op: no save.
	if _, err := h.HandleRPC("queue.reorder", []byte(`{"roomId":"noop","trackId":"`+trackID+`","toIndex":0}`), ""); err != nil {
		t.Fatalf("reorder: %v", err)
	}

	if got := st.saveCount(); got != 2 {
		t.Fatalf("no-op mutations wrote to the store: %d total saves, want 2", got)
	}
}
