package hub

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeClock is a manually advanced clock for rate-limiter tests (no sleeping).
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// newTestHub returns a hub whose fanout limiter has a shrunken burst and a
// fake clock, plus the clock so tests can simulate refill.
func newTestHub(t *testing.T, burst int, refill time.Duration) (*Hub, *fakeClock) {
	t.Helper()
	clock := &fakeClock{now: time.Now()}
	h := NewHub(nil)
	h.fanoutLimiter = newRateLimiter(burst, refill, clock.Now)
	return h, clock
}

func searchPayload() []byte { return []byte(`{"query":"bohemian rhapsody"}`) }

func TestFanoutRateLimit_BurstThenReject(t *testing.T) {
	h, _ := newTestHub(t, 3, time.Hour) // no refill during the test

	for i := 0; i < 3; i++ {
		if _, err := h.HandleRPC("track.search", searchPayload(), "u1"); err != nil {
			t.Fatalf("request %d within burst: got err %v", i+1, err)
		}
	}

	_, err := h.HandleRPC("track.search", searchPayload(), "u1")
	if err == nil {
		t.Fatal("expected 4th request to be rejected")
	}
	var ue *UserError
	if !errors.As(err, &ue) {
		t.Fatalf("rejection must be a *UserError (client-visible), got %T: %v", err, err)
	}
}

func TestFanoutRateLimit_NonFanoutUnaffected(t *testing.T) {
	h, _ := newTestHub(t, 1, time.Hour)

	if _, err := h.HandleRPC("track.search", searchPayload(), "u1"); err != nil {
		t.Fatalf("first search: %v", err)
	}
	if _, err := h.HandleRPC("track.search", searchPayload(), "u1"); err == nil {
		t.Fatal("second search should be rate-limited")
	}

	// Non-fanout RPCs do not draw from the fanout bucket.
	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"rl1","name":"u1"}`), "u1"); err != nil {
		t.Fatalf("room.join must not be rate-limited: %v", err)
	}
	add := []byte(`{"roomId":"rl1","track":{"title":"S","artist":"A","sources":{},"addedBy":"u1"}}`)
	for i := 0; i < 5; i++ {
		if _, err := h.HandleRPC("queue.add", add, "u1"); err != nil {
			t.Fatalf("queue.add %d must not be rate-limited: %v", i+1, err)
		}
	}
	if _, err := h.HandleRPC("sync.ping", []byte(`{}`), "u1"); err != nil {
		t.Fatalf("sync.ping must not be rate-limited: %v", err)
	}
}

func TestFanoutRateLimit_IndependentKeys(t *testing.T) {
	h, _ := newTestHub(t, 1, time.Hour)

	if _, err := h.HandleRPC("track.search", searchPayload(), "u1"); err != nil {
		t.Fatalf("u1 first search: %v", err)
	}
	if _, err := h.HandleRPC("track.search", searchPayload(), "u1"); err == nil {
		t.Fatal("u1 second search should be rate-limited")
	}
	// A different caller has its own bucket.
	if _, err := h.HandleRPC("track.search", searchPayload(), "u2"); err != nil {
		t.Fatalf("u2 first search must succeed: %v", err)
	}
}

func TestFanoutRateLimit_Refill(t *testing.T) {
	h, clock := newTestHub(t, 1, 2*time.Second)

	if _, err := h.HandleRPC("track.search", searchPayload(), "u1"); err != nil {
		t.Fatalf("first search: %v", err)
	}
	if _, err := h.HandleRPC("track.search", searchPayload(), "u1"); err == nil {
		t.Fatal("second search should be rate-limited")
	}

	clock.Advance(2 * time.Second) // one token refills
	if _, err := h.HandleRPC("track.search", searchPayload(), "u1"); err != nil {
		t.Fatalf("search after refill must succeed: %v", err)
	}
	// Bucket is empty again immediately after.
	if _, err := h.HandleRPC("track.search", searchPayload(), "u1"); err == nil {
		t.Fatal("search right after consuming refilled token should be rate-limited")
	}
}

func TestRateLimiter_EvictsIdleBuckets(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	l := newRateLimiter(1, time.Hour, clock.Now)

	if !l.allow("stale") {
		t.Fatal("first allow must succeed")
	}

	// Age the bucket past the idle TTL, then trigger the lazy sweep via a
	// different key once the sweep interval has elapsed.
	clock.Advance(fanoutIdleTTL + fanoutSweepEvery + time.Second)
	if !l.allow("fresh") {
		t.Fatal("allow for fresh key must succeed")
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.buckets["stale"]; ok {
		t.Fatal("idle bucket should have been evicted by the sweep")
	}
	if _, ok := l.buckets["fresh"]; !ok {
		t.Fatal("active bucket must survive the sweep")
	}
}
