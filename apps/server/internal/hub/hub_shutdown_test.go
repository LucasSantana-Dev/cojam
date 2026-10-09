package hub

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

// gateStore blocks the armed call until release is closed, so a test can hold
// a store write in flight while it calls a stop func (#394).
type gateStore struct {
	inner      *store.Memory
	armSave    atomic.Bool
	entered    chan struct{}
	release    chan struct{}
	enteredOne atomic.Bool
}

func newGateStore() *gateStore {
	return &gateStore{inner: store.NewMemory(), entered: make(chan struct{}), release: make(chan struct{})}
}

func (g *gateStore) hold() {
	if g.enteredOne.CompareAndSwap(false, true) {
		close(g.entered)
	}
	<-g.release
}

func (g *gateStore) Load(ctx context.Context, roomID string) (*queue.RoomState, error) {
	return g.inner.Load(ctx, roomID)
}

func (g *gateStore) Save(ctx context.Context, state *queue.RoomState) error {
	if g.armSave.Load() {
		g.hold()
	}
	return g.inner.Save(ctx, state)
}

func (g *gateStore) DeleteIdleRooms(ctx context.Context, cutoff time.Time, protected map[string]struct{}) (int64, error) {
	g.hold()
	return 0, nil
}

// assertStopWaits calls stop while a store call is held, checks it does not
// return until the call is released, then that it does.
func assertStopWaits(t *testing.T, g *gateStore, stop func()) {
	t.Helper()
	select {
	case <-g.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("store call never started")
	}
	returned := make(chan struct{})
	go func() {
		stop()
		close(returned)
	}()
	select {
	case <-returned:
		t.Fatal("stop returned while a store call was still in flight")
	case <-time.After(100 * time.Millisecond):
	}
	close(g.release)
	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("stop did not return after the store call finished")
	}
}

func TestStartRoomEvictor_StopWaitsForInFlightSweep(t *testing.T) {
	g := newGateStore()
	// 1ms TTL clamps to the 1s minimum sweep interval.
	h := NewHub(nil).WithStore(g).WithRoomPersistIdleTTL(time.Millisecond)

	assertStopWaits(t, g, h.StartRoomEvictor())
}

func TestStopHeartbeats_WaitsForInFlightBeat(t *testing.T) {
	g := newGateStore()
	h := NewHub(nil).WithStore(g).WithSync(true).WithVideo(true)
	h.heartbeatEvery = 20 * time.Millisecond
	h.publishFn = func(string, json.RawMessage) error { return nil }
	h.Join("c1", "demo")
	res, err := h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"V","artist":"A","kind":"video","sources":{"youtube":{"videoId":"abcdefghijk","confidence":1}},"addedBy":"u"}}`), "")
	if err != nil {
		t.Fatalf("queue.add: %v", err)
	}
	st := queue.RoomState{}
	_ = json.Unmarshal(res, &st)
	play(t, h, st.Queue[0].ID)
	waitFor(t, "ticker running", func() bool { return h.heartbeatCount() == 1 })

	// The next beat's save is held in flight.
	g.armSave.Store(true)
	assertStopWaits(t, g, h.StopHeartbeats)
}
