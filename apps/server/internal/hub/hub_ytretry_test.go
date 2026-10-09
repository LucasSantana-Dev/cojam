package hub

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// An idle room is woken at the quota reset: the owed lookup is retried and the
// state republishes (version bump) so clients drop the notice, with no other
// activity in the room.
func TestQuotaResetWakesIdleRoom(t *testing.T) {
	var tripped atomic.Bool
	var failing atomic.Bool
	failing.Store(true)
	var untilNs atomic.Int64
	h := NewHub(nil).WithAutoSkipSourceless(true).WithMatcher(func(_ context.Context, title, _, _ string) (*queue.SourceRef, error) {
		if failing.Load() {
			untilNs.Store(time.Now().Add(150 * time.Millisecond).UnixNano())
			tripped.Store(true)
			return nil, ErrQuotaExhausted
		}
		return &queue.SourceRef{VideoID: "v-" + title, Confidence: 0.9}, nil
	}).WithYouTubeQuota(func() time.Time {
		if !tripped.Load() {
			return time.Time{}
		}
		return time.Unix(0, untilNs.Load())
	})
	defer h.BeginShutdown()

	var mu sync.Mutex
	var last queue.RoomState
	h.publishFn = func(_ string, state json.RawMessage) error {
		mu.Lock()
		defer mu.Unlock()
		last = queue.RoomState{}
		return json.Unmarshal(state, &last)
	}

	winAdd(t, h, "idle0")
	waitFor(t, "owed after quota failure", func() bool { return winState(t, h).Queue[0].YTQuota })
	mu.Lock()
	stamped := last.YouTubeQuotaUntil
	mu.Unlock()
	if stamped == 0 {
		t.Fatal("quota notice was not stamped while exhausted")
	}

	failing.Store(false) // the quota comes back; nobody touches the room
	waitFor(t, "idle room retried at reset", func() bool { return winHasYT(t, h, "idle0") })
	waitFor(t, "notice dropped", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return last.YouTubeQuotaUntil == 0 && last.Version > 0
	})
}

// The reset timer is stopped on shutdown and never fires afterwards.
func TestQuotaResetTimerStoppedOnShutdown(t *testing.T) {
	until := time.Now().Add(80 * time.Millisecond)
	var fired atomic.Int32
	h := NewHub(nil).WithMatcher(func(context.Context, string, string, string) (*queue.SourceRef, error) {
		return nil, nil
	}).WithYouTubeQuota(func() time.Time {
		fired.Add(1)
		return until
	})
	if _, err := h.mutate(winRoom, func(s *queue.RoomState) error { s.Version++; return nil }); err != nil {
		t.Fatal(err)
	}
	h.BeginShutdown()
	before := fired.Load()
	time.Sleep(250 * time.Millisecond)
	if fired.Load() != before {
		t.Fatal("reset timer fired after shutdown")
	}
}

// A lookup that fails on a plain error (5xx, timeout) is re-claimed on the
// next mutation, capped at youtubeMaxAttempts, then settles as uncertain.
func TestYouTubeWindowRetriesNonQuotaFailureWithCap(t *testing.T) {
	var calls atomic.Int32
	h := NewHub(nil).WithMatcher(func(context.Context, string, string, string) (*queue.SourceRef, error) {
		calls.Add(1)
		return nil, errors.New("upstream status 503")
	})
	winAdd(t, h, "flaky")
	waitFor(t, "attempts capped", func() bool { return calls.Load() >= youtubeMaxAttempts })
	time.Sleep(150 * time.Millisecond)
	if n := calls.Load(); n != youtubeMaxAttempts {
		t.Fatalf("lookups = %d, want exactly %d", n, youtubeMaxAttempts)
	}
	tr := winState(t, h).Queue[0]
	if !tr.EnrichUncertain || tr.EnrichChecked || tr.EnrichPending != 0 || !tr.YTLookup {
		t.Fatalf("after the cap the track must settle uncertain, got %+v", tr)
	}
	// Further activity does not search again.
	if _, err := h.mutate(winRoom, func(s *queue.RoomState) error { s.Version++; return nil }); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if n := calls.Load(); n != youtubeMaxAttempts {
		t.Fatalf("lookups = %d after the cap, want %d", n, youtubeMaxAttempts)
	}
}

// A failure that recovers within the cap ends with the source applied.
func TestYouTubeWindowRetrySucceedsWithinCap(t *testing.T) {
	var calls atomic.Int32
	h := NewHub(nil).WithMatcher(func(_ context.Context, title, _, _ string) (*queue.SourceRef, error) {
		if calls.Add(1) < 2 {
			return nil, errors.New("timeout")
		}
		return &queue.SourceRef{VideoID: "v", Confidence: 0.9}, nil
	})
	winAdd(t, h, "recovers")
	waitFor(t, "source applied on retry", func() bool { return winHasYT(t, h, "recovers") })
}
