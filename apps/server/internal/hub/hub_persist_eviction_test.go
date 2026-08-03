package hub

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

// recordingStore wraps Memory and records each DeleteIdleRooms call so tests
// can assert the cutoff, the protected set, and the call count, and can
// script the removal count and failures.
type recordingStore struct {
	inner *store.Memory

	mu        sync.Mutex
	calls     int
	cutoff    time.Time
	protected map[string]struct{}
	removed   int64
	err       error
}

func (r *recordingStore) Load(ctx context.Context, roomID string) (*queue.RoomState, error) {
	return r.inner.Load(ctx, roomID)
}

func (r *recordingStore) Save(ctx context.Context, state *queue.RoomState) error {
	return r.inner.Save(ctx, state)
}

func (r *recordingStore) DeleteIdleRooms(ctx context.Context, cutoff time.Time, protected map[string]struct{}) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	r.cutoff = cutoff
	r.protected = protected
	return r.removed, r.err
}

func (r *recordingStore) recorded() (calls int, cutoff time.Time, protected map[string]struct{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls, r.cutoff, r.protected
}

// #169: a non-positive persistent TTL disables the sweep before it touches
// the store at all.
func TestEvictPersistedIdleRooms_Disabled(t *testing.T) {
	rs := &recordingStore{inner: store.NewMemory()}
	h := NewHub(nil).WithStore(rs)

	h.evictPersistedIdleRooms(time.Now())

	if calls, _, _ := rs.recorded(); calls != 0 {
		t.Fatalf("disabled sweep must not call the store, calls = %d", calls)
	}
}

// #169 SAFETY: a room with a connected member is passed to the store as
// protected however old its row is. This is the test that fails if the
// membership gate is dropped: an empty or memberless protected set means a
// live room's row can be deleted.
func TestEvictPersistedIdleRooms_ProtectsMemberedRooms(t *testing.T) {
	rs := &recordingStore{inner: store.NewMemory()}
	h := NewHub(nil).WithStore(rs).WithRoomPersistIdleTTL(time.Hour)
	h.Join("client-1", "membered")
	mustRoom(t, h, "membered") // resident AND membered: the dangerous case
	mustRoom(t, h, "memberless")

	now := time.Now()
	h.evictPersistedIdleRooms(now)

	calls, cutoff, protected := rs.recorded()
	if calls != 1 {
		t.Fatalf("sweep calls = %d, want 1", calls)
	}
	if want := now.Add(-time.Hour); !cutoff.Equal(want) {
		t.Fatalf("cutoff = %v, want %v (now - TTL)", cutoff, want)
	}
	if _, ok := protected["membered"]; !ok {
		t.Fatal("room with a connected member must be in the protected set")
	}
	if _, ok := protected["memberless"]; ok {
		t.Fatal("memberless room must not be protected")
	}
}

// #169: with no memberships at all the protected set is an allocated empty
// map, never nil — the store's nil-check must not fire on a legitimate
// "nothing to protect" sweep.
func TestEvictPersistedIdleRooms_EmptyProtectedSetIsNotNil(t *testing.T) {
	rs := &recordingStore{inner: store.NewMemory()}
	h := NewHub(nil).WithStore(rs).WithRoomPersistIdleTTL(time.Hour)

	h.evictPersistedIdleRooms(time.Now())

	calls, _, protected := rs.recorded()
	if calls != 1 {
		t.Fatalf("sweep calls = %d, want 1", calls)
	}
	if protected == nil {
		t.Fatal("protected set must be allocated even when no room has members")
	}
	if len(protected) != 0 {
		t.Fatalf("protected set = %v, want empty", protected)
	}
}

// #169: the counter increases by the number of rows removed and is unchanged
// on an empty sweep.
func TestEvictPersistedIdleRooms_CountsRemovedRows(t *testing.T) {
	metrics := obs.New()
	rs := &recordingStore{inner: store.NewMemory(), removed: 3}
	h := NewHub(nil).WithStore(rs).WithObservability(nil, metrics).WithRoomPersistIdleTTL(time.Hour)

	h.evictPersistedIdleRooms(time.Now())
	if got := testutil.ToFloat64(metrics.RoomsPersistedEvicted); got != 3 {
		t.Fatalf("rooms_persisted_evicted_total = %v, want 3", got)
	}

	rs.removed = 0
	h.evictPersistedIdleRooms(time.Now())
	if got := testutil.ToFloat64(metrics.RoomsPersistedEvicted); got != 3 {
		t.Fatalf("empty sweep must not move the counter, got %v", got)
	}
}

// #169: a store failure logs and returns — it must not panic the evictor or
// move the counter, and the next tick retries.
func TestEvictPersistedIdleRooms_StoreErrorDoesNotAbort(t *testing.T) {
	metrics := obs.New()
	rs := &recordingStore{inner: store.NewMemory(), err: errors.New("connection reset")}
	h := NewHub(nil).WithStore(rs).WithObservability(nil, metrics).WithRoomPersistIdleTTL(time.Hour)

	h.evictPersistedIdleRooms(time.Now()) // must not panic
	if got := testutil.ToFloat64(metrics.RoomsPersistedEvicted); got != 0 {
		t.Fatalf("failed sweep must not move the counter, got %v", got)
	}

	rs.err = nil
	rs.removed = 2
	h.evictPersistedIdleRooms(time.Now())
	if got := testutil.ToFloat64(metrics.RoomsPersistedEvicted); got != 2 {
		t.Fatalf("next tick must retry and count, got %v", got)
	}
}

// #169: concurrent joins, leaves, mutations, and sweeps — a race-detector
// smoke test for the membership snapshot under memberMu.
func TestEvictPersistedIdleRooms_Concurrent(t *testing.T) {
	rs := &recordingStore{inner: store.NewMemory()}
	h := NewHub(nil).WithStore(rs).WithRoomPersistIdleTTL(time.Millisecond)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			clientID := string(rune('a' + i))
			roomID := string(rune('A' + i%4))
			for j := 0; j < 50; j++ {
				h.Join(clientID, roomID)
				if _, err := h.mutate(roomID, func(s *queue.RoomState) error {
					s.RadioEnabled = true
					s.Version++
					return nil
				}); err != nil {
					t.Errorf("mutate: %v", err)
				}
				h.evictPersistedIdleRooms(time.Now())
				h.Leave(clientID)
			}
		}(i)
	}
	wg.Wait()
}
