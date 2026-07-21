package hub

import (
	"context"
	"sync"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

// barrierStore wraps Memory and parks every Load until `parties` goroutines
// have arrived, forcing the check-then-act window in GetOrCreateRoom wide
// open: all callers miss the map, all enter Load, all are released together.
type barrierStore struct {
	inner   store.Store
	parties int
	arrived chan struct{}
	release chan struct{}
	once    sync.Once
}

func newBarrierStore(parties int) *barrierStore {
	return &barrierStore{
		inner:   store.NewMemory(),
		parties: parties,
		arrived: make(chan struct{}, parties),
		release: make(chan struct{}),
	}
}

func (b *barrierStore) Load(ctx context.Context, roomID string) (*queue.RoomState, error) {
	b.arrived <- struct{}{}
	if len(b.arrived) == b.parties {
		b.once.Do(func() { close(b.release) })
	}
	<-b.release
	return b.inner.Load(ctx, roomID)
}

func (b *barrierStore) Save(ctx context.Context, state *queue.RoomState) error {
	return b.inner.Save(ctx, state)
}

// TestGetOrCreateRoomSingleInstance verifies that concurrent creators for the
// same roomID all receive the SAME *Room. With the old check-then-act code
// (map check, unlock, load, insert) every caller built its own instance and
// the losers' mutations went to an orphaned Room whose state was never
// published or persisted.
func TestGetOrCreateRoomSingleInstance(t *testing.T) {
	const parties = 8
	h := NewHub(nil).WithStore(newBarrierStore(parties))

	rooms := make([]*Room, parties)
	var wg sync.WaitGroup
	wg.Add(parties)
	for i := 0; i < parties; i++ {
		go func(i int) {
			defer wg.Done()
			rooms[i] = h.GetOrCreateRoom("race-room")
		}(i)
	}
	wg.Wait()

	for i := 1; i < parties; i++ {
		if rooms[i] != rooms[0] {
			t.Fatalf("caller %d got a different *Room (%p) than caller 0 (%p): check-then-act race orphaned an instance", i, rooms[i], rooms[0])
		}
	}
}
