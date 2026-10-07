package hub

import (
	"encoding/json"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

type pubLog struct {
	mu    sync.Mutex
	state []queue.RoomState
}

func (p *pubLog) add(raw json.RawMessage) {
	var s queue.RoomState
	_ = json.Unmarshal(raw, &s)
	p.mu.Lock()
	p.state = append(p.state, s)
	p.mu.Unlock()
}

func (p *pubLog) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.state)
}

func newVideoHub(t *testing.T, kind string) (*Hub, *pubLog, string) {
	t.Helper()
	h := NewHub(nil).WithSync(true).WithVideo(true)
	h.heartbeatEvery = 20 * time.Millisecond
	log := &pubLog{}
	h.publishFn = func(_ string, st json.RawMessage) error { log.add(st); return nil }
	t.Cleanup(h.StopHeartbeats)
	h.Join("c1", "demo")
	res, err := h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"V","artist":"A","kind":"`+kind+`","sources":{"youtube":{"videoId":"abcdefghijk","confidence":1}},"addedBy":"u"}}`), "")
	if err != nil {
		t.Fatalf("queue.add: %v", err)
	}
	st := queue.RoomState{}
	_ = json.Unmarshal(res, &st)
	return h, log, st.Queue[0].ID
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func play(t *testing.T, h *Hub, id string) {
	t.Helper()
	if _, err := h.HandleRPC("transport.play", []byte(`{"roomId":"demo","trackId":"`+id+`","positionMs":0}`), ""); err != nil {
		t.Fatalf("transport.play: %v", err)
	}
}

func TestVideoHeartbeatRepublishesWithBumpedVersion(t *testing.T) {
	h, log, id := newVideoHub(t, "video")
	play(t, h, id)
	base := log.count()
	waitFor(t, "two beats", func() bool { return log.count() >= base+2 })
	log.mu.Lock()
	a, b := log.state[base], log.state[base+1]
	log.mu.Unlock()
	if b.Version <= a.Version {
		t.Fatalf("heartbeat must bump version: %d then %d", a.Version, b.Version)
	}
	if a.Transport == nil || b.Transport == nil || *a.Transport != *b.Transport {
		t.Fatalf("heartbeat must not re-stamp transport (drift loop would re-seek): %+v vs %+v", a.Transport, b.Transport)
	}
}

func TestVideoHeartbeatStopsOnPause(t *testing.T) {
	h, log, id := newVideoHub(t, "video")
	play(t, h, id)
	waitFor(t, "ticker running", func() bool { return h.heartbeatCount() == 1 })
	if _, err := h.HandleRPC("transport.pause", []byte(`{"roomId":"demo","positionMs":500}`), ""); err != nil {
		t.Fatal(err)
	}
	if n := h.heartbeatCount(); n != 0 {
		t.Fatalf("ticker must stop on pause, got %d", n)
	}
	time.Sleep(80 * time.Millisecond)
	after := log.count()
	time.Sleep(80 * time.Millisecond)
	if log.count() != after {
		t.Fatalf("published while paused")
	}
}

func TestVideoHeartbeatNotForAudioOrFlagOff(t *testing.T) {
	h, _, id := newVideoHub(t, "audio")
	play(t, h, id)
	if n := h.heartbeatCount(); n != 0 {
		t.Fatalf("audio track must not heartbeat, got %d", n)
	}
	h2, _, id2 := newVideoHub(t, "video")
	h2.videoEnabled = false
	play(t, h2, id2)
	h2.StopHeartbeats()
	play(t, h2, id2)
	if n := h2.heartbeatCount(); n != 0 {
		t.Fatalf("flag off must not heartbeat, got %d", n)
	}
}

func TestVideoHeartbeatStopsOnEviction(t *testing.T) {
	h, _, id := newVideoHub(t, "video")
	h.WithRoomIdleTTL(time.Minute)
	play(t, h, id)
	waitFor(t, "ticker running", func() bool { return h.heartbeatCount() == 1 })
	h.Leave("c1")
	h.evictIdleRooms(time.Now().Add(time.Hour))
	if n := h.heartbeatCount(); n != 0 {
		t.Fatalf("ticker must stop on eviction, got %d", n)
	}
}

func TestVideoHeartbeatStopsWhenRoomEmpties(t *testing.T) {
	h, _, id := newVideoHub(t, "video")
	play(t, h, id)
	waitFor(t, "ticker running", func() bool { return h.heartbeatCount() == 1 })
	h.Leave("c1")
	waitFor(t, "ticker exit on empty room", func() bool { return h.heartbeatCount() == 0 })
}

func TestVideoHeartbeatNoGoroutineLeak(t *testing.T) {
	before := runtime.NumGoroutine()
	h, _, id := newVideoHub(t, "video")
	play(t, h, id)
	waitFor(t, "ticker running", func() bool { return h.heartbeatCount() == 1 })
	h.StopHeartbeats()
	waitFor(t, "goroutines drained", func() bool { return runtime.NumGoroutine() <= before })
}

func TestTransportLimiterIsSeparateFromFanout(t *testing.T) {
	h := NewHub(nil).WithSync(true)
	h.transportLimiter = newRateLimiter(2, time.Hour, time.Now)
	h.HandleRPC("room.join", []byte(`{"roomId":"demo","name":"t"}`), "")
	for i := 0; i < 2; i++ {
		if _, err := h.HandleRPC("transport.seek", []byte(`{"roomId":"demo","positionMs":1}`), ""); err != nil {
			t.Fatalf("seek %d: %v", i, err)
		}
	}
	if _, err := h.HandleRPC("transport.seek", []byte(`{"roomId":"demo","positionMs":1}`), ""); err == nil {
		t.Fatal("third seek must be limited")
	}
	if fanoutMethods["transport.seek"] {
		t.Fatal("transport must not draw from fanoutLimiter")
	}
}

// Regression guard for #175: a video ending on an empty queue must not reset
// NowPlaying to the oldest played entry, and the late duplicate ENDED every
// other client fires must stay a no-op. The heartbeat must also stop.
func TestVideoEndOnDrainedQueueDoesNotResetNowPlaying(t *testing.T) {
	h, _, id := newVideoHub(t, "video")
	play(t, h, id)
	waitFor(t, "ticker running", func() bool { return h.heartbeatCount() == 1 })
	for i := 0; i < 2; i++ {
		res, err := h.HandleRPC("now_playing.advance", []byte(`{"roomId":"demo","afterId":"`+id+`"}`), "")
		if err != nil {
			t.Fatalf("advance %d: %v", i, err)
		}
		st := queue.RoomState{}
		_ = json.Unmarshal(res, &st)
		if st.NowPlayingID != "" {
			t.Fatalf("advance %d: nowPlaying = %q, want empty (drained queue)", i, st.NowPlayingID)
		}
	}
	if n := h.heartbeatCount(); n != 0 {
		t.Fatalf("ticker must stop when the video ends, got %d", n)
	}
}
