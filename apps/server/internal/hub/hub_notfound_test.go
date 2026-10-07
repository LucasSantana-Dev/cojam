package hub

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

// countingStore wraps the memory store and counts Load calls.
type countingStore struct {
	*store.Memory
	loads atomic.Int64
}

func (c *countingStore) Load(ctx context.Context, roomID string) (*queue.RoomState, error) {
	c.loads.Add(1)
	return c.Memory.Load(ctx, roomID)
}

// Host checks on a room that exists nowhere must not hit the store on every
// RPC: a "not found" answer is cached for notFoundTTL.
func TestHostGate_NonexistentRoom_StoreLoadedOncePerTTL(t *testing.T) {
	cs := &countingStore{Memory: store.NewMemory()}
	clock := &fakeClock{now: time.Now()}
	h := NewHub(nil).WithStore(cs).WithHostAssignment(true)
	h.notFound.now = clock.Now
	h.RecordClientUserID("c1", "u1")
	h.Join("c1", "NOSUCHROOM")

	c := newTestClient("c1", "u1")
	payload := []byte(`{"roomId":"NOSUCHROOM","trackId":"t1"}`)
	for i := 0; i < 5; i++ {
		if err := h.Authorize(c, "now_playing.set", payload); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
			t.Fatalf("call %d: got %v, want ErrorPermissionDenied", i+1, err)
		}
	}
	if got := cs.loads.Load(); got != 1 {
		t.Fatalf("store loads within the TTL = %d, want 1", got)
	}

	clock.Advance(notFoundTTL + time.Second)
	if err := h.Authorize(c, "now_playing.set", payload); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("after TTL: got %v", err)
	}
	if got := cs.loads.Load(); got != 2 {
		t.Fatalf("store loads after the TTL = %d, want 2", got)
	}
}

// Creating the room clears its cached "not found" so it is seen at once.
func TestNotFoundCache_ClearedOnCreate(t *testing.T) {
	h := NewHub(nil).WithHostAssignment(true)
	h.RecordClientUserID("c1", "u1")
	h.Join("c1", "LATERROOM")
	c := newTestClient("c1", "u1")
	payload := []byte(`{"roomId":"LATERROOM","trackId":"t1"}`)
	if err := h.Authorize(c, "now_playing.set", payload); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("before create: got %v", err)
	}
	if _, err := h.handleRPC("room.join", []byte(`{"roomId":"LATERROOM"}`), "c1", "u1"); err != nil {
		t.Fatalf("room.join: %v", err)
	}
	if err := h.Authorize(c, "now_playing.set", payload); err != nil {
		t.Fatalf("host after create: got %v, want nil", err)
	}
}

// The not-found cache stays bounded.
func TestNotFoundCache_Bounded(t *testing.T) {
	c := newNotFoundCache(3)
	for _, id := range []string{"A", "B", "C", "D", "E"} {
		c.add(id)
	}
	if n := c.len(); n > 3 {
		t.Fatalf("cache size = %d, want <= 3", n)
	}
}

// On the transport path the per-caller limiter runs before Authorize, so a
// throttled caller cannot drive host checks (and their store loads).
func TestServeRPC_LimitBeforeHostCheck(t *testing.T) {
	cs := &countingStore{Memory: store.NewMemory()}
	h := NewHub(nil).WithStore(cs).WithHostAssignment(true)
	h.notFound = newNotFoundCache(0) // no caching: count every load
	h.mutationLimiter = newRateLimiter(1, time.Hour, time.Now)
	h.RecordClientUserID("c1", "u1")
	h.Join("c1", "NOSUCHROOM")
	c := newTestClient("c1", "u1")
	payload := []byte(`{"roomId":"NOSUCHROOM","trackId":"t1"}`)

	if _, err := h.serveRPC(c, "now_playing.set", payload); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("first call: got %v, want ErrorPermissionDenied", err)
	}
	before := cs.loads.Load()
	for i := 0; i < 3; i++ {
		_, err := h.serveRPC(c, "now_playing.set", payload)
		var ue *UserError
		if !errors.As(err, &ue) {
			t.Fatalf("throttled call: got %v, want the rate-limit UserError", err)
		}
	}
	if got := cs.loads.Load(); got != before {
		t.Fatalf("throttled calls loaded the store %d more times, want 0", got-before)
	}
}
