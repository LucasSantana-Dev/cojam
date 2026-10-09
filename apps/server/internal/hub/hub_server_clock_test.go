package hub

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

func rpcState(t *testing.T, h *Hub, method, body string) queue.RoomState {
	t.Helper()
	res, err := h.HandleRPC(method, []byte(body), "")
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	var s queue.RoomState
	if err := json.Unmarshal(res, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

const addA = `{"roomId":"clk","track":{"title":"A","artist":"x","sources":{},"addedBy":"u1"}}`
const addB = `{"roomId":"clk","track":{"title":"B","artist":"x","sources":{},"addedBy":"u1"}}`

func TestAddToEmptyRoomStartsServerClock(t *testing.T) {
	h := NewHub(nil).WithSync(true)
	rpcState(t, h, "room.join", `{"roomId":"clk","name":"ana"}`)
	s := rpcState(t, h, "queue.add", addA)
	if s.Transport == nil || s.Transport.State != "playing" || s.Transport.PositionMs != 0 {
		t.Fatalf("transport = %+v, want playing at 0", s.Transport)
	}
	if age := time.Now().UnixMilli() - s.Transport.UpdatedAtServerMs; age < 0 || age > 5000 {
		t.Fatalf("anchor age %dms", age)
	}
}

func TestAdvanceReanchorsAutoTransport(t *testing.T) {
	h := NewHub(nil).WithSync(true)
	rpcState(t, h, "room.join", `{"roomId":"clk","name":"ana"}`)
	rpcState(t, h, "queue.add", addA)
	s := rpcState(t, h, "queue.add", addB)
	first := s.Transport.UpdatedAtServerMs
	time.Sleep(5 * time.Millisecond)
	s = rpcState(t, h, "now_playing.advance", `{"roomId":"clk","afterId":"`+s.NowPlayingID+`"}`)
	if s.Transport == nil || s.Transport.State != "playing" || s.Transport.PositionMs != 0 || s.Transport.UpdatedAtServerMs <= first {
		t.Fatalf("transport = %+v, want re-anchored (first %d)", s.Transport, first)
	}
}

func TestSyncOffCreatesNoTransport(t *testing.T) {
	h := NewHub(nil)
	rpcState(t, h, "room.join", `{"roomId":"clk","name":"ana"}`)
	s := rpcState(t, h, "queue.add", addA)
	if s.Transport != nil {
		t.Fatalf("transport = %+v, want nil with sync off", s.Transport)
	}
}

func TestJoinBackfillsPlayingRoomWithoutTransport(t *testing.T) {
	mem := store.NewMemory()
	st := &queue.RoomState{
		RoomID:       "clk",
		Queue:        []queue.TrackRef{{ID: "t1", Title: "One", DurationMs: 200_000}},
		NowPlayingID: "t1",
		Version:      3,
	}
	if err := mem.Save(context.Background(), st); err != nil {
		t.Fatal(err)
	}
	m := obs.New()
	h := NewHub(nil).WithStore(mem).WithSync(true).WithObservability(nil, m)
	s := rpcState(t, h, "room.join", `{"roomId":"clk","name":"ana"}`)
	if s.Transport == nil || s.Transport.State != "playing" || s.Transport.PositionMs != 0 {
		t.Fatalf("transport = %+v, want backfilled playing at 0", s.Transport)
	}
	if got := testutil.ToFloat64(m.PlayingWithoutTransport); got != 1 {
		t.Fatalf("playing_without_transport = %v, want 1", got)
	}
	// A second join finds the transport: no new signal.
	rpcState(t, h, "room.join", `{"roomId":"clk","name":"bo"}`)
	if got := testutil.ToFloat64(m.PlayingWithoutTransport); got != 1 {
		t.Fatalf("counter moved to %v after backfill", got)
	}
}

func TestNormalAddDoesNotCountAsAbsent(t *testing.T) {
	m := obs.New()
	h := NewHub(nil).WithSync(true).WithObservability(nil, m)
	rpcState(t, h, "room.join", `{"roomId":"clk","name":"ana"}`)
	rpcState(t, h, "queue.add", addA)
	rpcState(t, h, "queue.add", addB)
	if got := testutil.ToFloat64(m.PlayingWithoutTransport); got != 0 {
		t.Fatalf("counter = %v, want 0", got)
	}
}

func TestQueueEndKeepsTransportAsToday(t *testing.T) {
	h := NewHub(nil).WithSync(true)
	rpcState(t, h, "room.join", `{"roomId":"clk","name":"ana"}`)
	s := rpcState(t, h, "queue.add", addA)
	s = rpcState(t, h, "now_playing.advance", `{"roomId":"clk","afterId":"`+s.NowPlayingID+`"}`)
	if s.NowPlayingID != "" {
		t.Fatalf("now playing = %q, want empty", s.NowPlayingID)
	}
	if s.Transport == nil {
		t.Fatal("existing transport must not vanish")
	}
}
