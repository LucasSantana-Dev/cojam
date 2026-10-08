package hub

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

// staleRoom is the prod shape: playing at 0 stamped an hour ago, a 3:43 track
// now playing, one more queued.
func staleRoom(updatedAgo time.Duration) *queue.RoomState {
	return &queue.RoomState{
		RoomID: "stale",
		Queue: []queue.TrackRef{
			{ID: "t1", Title: "One", DurationMs: 223_000},
			{ID: "t2", Title: "Two", DurationMs: 180_000},
		},
		NowPlayingID: "t1",
		Version:      5,
		Transport: &queue.TransportState{
			State:             "playing",
			PositionMs:        0,
			UpdatedAtServerMs: time.Now().Add(-updatedAgo).UnixMilli(),
		},
	}
}

func joinStale(t *testing.T, st store.Store) queue.RoomState {
	t.Helper()
	h := NewHub(nil).WithStore(st)
	res, err := h.HandleRPC("room.join", []byte(`{"roomId":"stale","name":"ana"}`), "")
	if err != nil {
		t.Fatalf("room.join: %v", err)
	}
	var s queue.RoomState
	if err := json.Unmarshal(res, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestJoinAdvancesStaleRestoredTransport(t *testing.T) {
	mem := store.NewMemory()
	if err := mem.Save(context.Background(), staleRoom(62*time.Minute)); err != nil {
		t.Fatal(err)
	}
	s := joinStale(t, mem)
	if s.NowPlayingID != "t2" {
		t.Fatalf("now playing = %q, want t2 after the stale restore", s.NowPlayingID)
	}
	if s.Transport == nil || s.Transport.PositionMs != 0 || s.Transport.State != "playing" {
		t.Fatalf("transport = %+v, want playing from 0", s.Transport)
	}
	if age := time.Now().UnixMilli() - s.Transport.UpdatedAtServerMs; age > 5000 {
		t.Fatalf("transport anchor is %dms old, want fresh", age)
	}
	// Persisted: a second restart does not see the stale state again.
	saved, err := mem.Load(context.Background(), "stale")
	if err != nil || saved.NowPlayingID != "t2" {
		t.Fatalf("saved now playing = %v (err %v), want t2", saved, err)
	}
}

func TestJoinKeepsLiveTransport(t *testing.T) {
	mem := store.NewMemory()
	if err := mem.Save(context.Background(), staleRoom(30*time.Second)); err != nil {
		t.Fatal(err)
	}
	if s := joinStale(t, mem); s.NowPlayingID != "t1" {
		t.Fatalf("now playing = %q, a track mid-play must stay", s.NowPlayingID)
	}
}

func TestStaleAdvanceDoesNotRefillRadio(t *testing.T) {
	mem := store.NewMemory()
	st := staleRoom(62 * time.Minute)
	st.NowPlayingID = "t2" // last track: the advance empties the queue
	st.Queue[1].DurationMs = 180_000
	st.RadioEnabled = true
	if err := mem.Save(context.Background(), st); err != nil {
		t.Fatal(err)
	}
	calls := make(chan struct{}, 4)
	h := NewHub(nil).WithStore(mem).WithSimilarProvider(func(_ context.Context, _, _ string, _ int) ([]queue.TrackRef, error) {
		calls <- struct{}{}
		return nil, nil
	})
	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"stale","name":"ana"}`), ""); err != nil {
		t.Fatal(err)
	}
	select {
	case <-calls:
		t.Fatal("a stale-transport advance must not trigger a radio refill")
	case <-time.After(150 * time.Millisecond):
	}
}
