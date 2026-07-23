package hub

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// TestEvictIdleRooms pins the idle-TTL sweep (issue #118): only rooms with no
// connected members AND no activity inside the TTL are dropped from hub
// memory, and an evicted room rejoins through GetOrCreateRoom with its
// store-persisted state intact.
func TestEvictIdleRooms(t *testing.T) {
	h := NewHub(nil).WithRoomIdleTTL(time.Minute)

	// stale: memberless and idle past the TTL -> evictable. Persist a track
	// first so the rejoin below can prove state survived eviction.
	if _, err := h.mutate("stale", func(s *queue.RoomState) error {
		s.Add(queue.TrackRef{Title: "persisted", Artist: "A"})
		return nil
	}); err != nil {
		t.Fatalf("mutate stale: %v", err)
	}
	h.GetOrCreateRoom("stale").lastActivityUnix.Store(time.Now().Add(-2 * time.Minute).UnixNano())

	// membered: a client holds membership -> never evictable, even when idle.
	h.GetOrCreateRoom("membered").lastActivityUnix.Store(time.Now().Add(-2 * time.Minute).UnixNano())
	h.Join("client-1", "membered")

	// fresh: memberless but active now -> not yet idle.
	h.GetOrCreateRoom("fresh")

	h.evictIdleRooms(time.Now())

	h.mu.RLock()
	_, staleExists := h.rooms["stale"]
	_, memberedExists := h.rooms["membered"]
	_, freshExists := h.rooms["fresh"]
	h.mu.RUnlock()

	if staleExists {
		t.Fatal("memberless room idle past the TTL should have been evicted")
	}
	if !memberedExists {
		t.Fatal("room with a connected member must not be evicted")
	}
	if !freshExists {
		t.Fatal("room active inside the TTL must not be evicted")
	}

	// Rejoin: GetOrCreateRoom reloads the persisted state from the store.
	rejoined := h.GetOrCreateRoom("stale")
	if len(rejoined.State.Queue) != 1 || rejoined.State.Queue[0].Title != "persisted" {
		t.Fatalf("evicted room did not reload persisted state, queue=%+v", rejoined.State.Queue)
	}
}

// TestEvictIdleRoomsDisabled verifies a hub without WithRoomIdleTTL never
// evicts, preserving the pre-#118 behavior for embedders that do not opt in.
func TestEvictIdleRoomsDisabled(t *testing.T) {
	h := NewHub(nil)
	room := h.GetOrCreateRoom("room")
	room.lastActivityUnix.Store(time.Now().Add(-time.Hour).UnixNano())

	h.evictIdleRooms(time.Now())

	h.mu.RLock()
	_, exists := h.rooms["room"]
	h.mu.RUnlock()
	if !exists {
		t.Fatal("hub with eviction disabled must not drop rooms")
	}
}

// TestEvictIdleRoomsConcurrent hammers the sweep against concurrent creators,
// joiners, and mutators so -race catches lock-ordering regressions between
// h.mu, memberMu, and the atomic activity timestamp.
func TestEvictIdleRoomsConcurrent(t *testing.T) {
	h := NewHub(nil).WithRoomIdleTTL(time.Millisecond)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			clientID := fmt.Sprintf("client-%d", i)
			roomID := fmt.Sprintf("room-%d", i%4)
			for j := 0; j < 50; j++ {
				h.GetOrCreateRoom(roomID)
				h.Join(clientID, roomID)
				if _, err := h.mutate(roomID, func(s *queue.RoomState) error {
					s.RadioEnabled = true
					s.Version++
					return nil
				}); err != nil {
					t.Errorf("mutate: %v", err)
				}
				h.Leave(clientID)
				h.evictIdleRooms(time.Now())
			}
		}(i)
	}
	wg.Wait()
}
