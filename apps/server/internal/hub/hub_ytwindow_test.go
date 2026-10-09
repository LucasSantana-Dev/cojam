package hub

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// ytRecorder is a YouTube matcher that records which titles were looked up,
// and can be switched to fail on the quota.
type ytRecorder struct {
	mu     sync.Mutex
	titles []string
	quota  bool
}

func (r *ytRecorder) match(_ context.Context, title, _, _ string) (*queue.SourceRef, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.titles = append(r.titles, title)
	if r.quota {
		return nil, fmt.Errorf("search: %w", ErrQuotaExhausted)
	}
	return &queue.SourceRef{VideoID: "v-" + title, Confidence: 0.9}, nil
}

func (r *ytRecorder) setQuota(v bool) {
	r.mu.Lock()
	r.quota = v
	r.mu.Unlock()
}

func (r *ytRecorder) looked() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := append([]string(nil), r.titles...)
	sort.Strings(out)
	return out
}

func (r *ytRecorder) count(title string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, t := range r.titles {
		if t == title {
			n++
		}
	}
	return n
}

const winRoom = "WINROOM1"

func winAdd(t *testing.T, h *Hub, titles ...string) {
	t.Helper()
	for _, title := range titles {
		p, _ := json.Marshal(map[string]any{
			"roomId": winRoom,
			"track":  map[string]any{"title": title, "artist": "A", "sources": map[string]any{}},
		})
		if _, err := h.HandleRPC("queue.add", p, ""); err != nil {
			t.Fatalf("queue.add %s: %v", title, err)
		}
	}
}

func winState(t *testing.T, h *Hub) queue.RoomState {
	t.Helper()
	room := mustRoom(t, h, winRoom)
	room.mu.Lock()
	defer room.mu.Unlock()
	cp := *room.State
	cp.Queue = append([]queue.TrackRef(nil), room.State.Queue...)
	return cp
}

func winHasYT(t *testing.T, h *Hub, title string) bool {
	for _, tr := range winState(t, h).Queue {
		if tr.Title == title {
			return tr.Sources.YouTube != nil
		}
	}
	t.Fatalf("track %q not in queue", title)
	return false
}

// Only now playing plus the next two are looked up; the rest stay un-enriched
// until they enter the window.
func TestYouTubeWindowOnlyFirstThreeEnriched(t *testing.T) {
	rec := &ytRecorder{}
	h := NewHub(nil).WithMatcher(rec.match)
	winAdd(t, h, "t0", "t1", "t2", "t3", "t4", "t5")

	waitFor(t, "window enriched", func() bool {
		return winHasYT(t, h, "t0") && winHasYT(t, h, "t1") && winHasYT(t, h, "t2")
	})
	time.Sleep(100 * time.Millisecond)
	if got := rec.looked(); fmt.Sprint(got) != "[t0 t1 t2]" {
		t.Fatalf("looked up %v, want exactly the window [t0 t1 t2]", got)
	}
	if winHasYT(t, h, "t3") {
		t.Fatal("t3 is outside the window and must stay un-enriched")
	}
}

// Advancing pulls the next track into the window and enriches it, exactly once.
func TestYouTubeWindowAdvanceEnrichesNewlyInWindow(t *testing.T) {
	rec := &ytRecorder{}
	h := NewHub(nil).WithMatcher(rec.match)
	winAdd(t, h, "t0", "t1", "t2", "t3", "t4")
	waitFor(t, "initial window", func() bool { return winHasYT(t, h, "t2") })

	st := winState(t, h)
	if _, err := h.HandleRPC("now_playing.advance", []byte(`{"roomId":"`+winRoom+`","afterId":"`+st.NowPlayingID+`"}`), ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "t3 enriched after advance", func() bool { return winHasYT(t, h, "t3") })
	time.Sleep(100 * time.Millisecond)
	if winHasYT(t, h, "t4") {
		t.Fatal("t4 is still outside the window")
	}
	for _, title := range []string{"t0", "t1", "t2", "t3"} {
		if n := rec.count(title); n != 1 {
			t.Fatalf("%s looked up %d times, want 1", title, n)
		}
	}
}

// A burst of mutations never looks the same track up twice.
func TestYouTubeWindowDedupesConcurrentMutations(t *testing.T) {
	gate := make(chan struct{})
	var mu sync.Mutex
	calls := map[string]int{}
	h := NewHub(nil).WithMatcher(func(_ context.Context, title, _, _ string) (*queue.SourceRef, error) {
		mu.Lock()
		calls[title]++
		mu.Unlock()
		<-gate
		return &queue.SourceRef{VideoID: "v", Confidence: 0.9}, nil
	})
	winAdd(t, h, "a", "b", "c")
	for i := 0; i < 5; i++ {
		h.ensureYouTubeWindow(winRoom)
		if _, err := h.mutate(winRoom, func(s *queue.RoomState) error { s.Version++; return nil }); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(50 * time.Millisecond)
	close(gate)
	waitFor(t, "window done", func() bool { return winHasYT(t, h, "c") })
	mu.Lock()
	defer mu.Unlock()
	for title, n := range calls {
		if n != 1 {
			t.Fatalf("%s looked up %d times, want 1", title, n)
		}
	}
}

// A track outside the window never looks "definitively sourceless": it stays
// unchecked and unpending, and auto skip only judges the now-playing track once
// its own lookup finished.
func TestYouTubeWindowOutOfWindowTrackNotChecked(t *testing.T) {
	rec := &ytRecorder{}
	h := NewHub(nil).WithMatcher(rec.match)
	winAdd(t, h, "t0", "t1", "t2", "t3")
	waitFor(t, "window enriched", func() bool { return winHasYT(t, h, "t2") })
	st := winState(t, h)
	last := st.Queue[3]
	if last.YTLookup || last.EnrichChecked || last.EnrichPending != 0 {
		t.Fatalf("out-of-window track bookkeeping = %+v, want untouched", last)
	}
}

// While the quota is exhausted no lookup is launched, in-window tracks stay
// retryable (uncertain, so auto skip never drains the queue), and the first
// activity after the reset retries them.
func TestYouTubeWindowQuotaRetryAfterReset(t *testing.T) {
	rec := &ytRecorder{}
	var mu sync.Mutex
	var until time.Time
	h := NewHub(nil).WithAutoSkipSourceless(true).WithMatcher(rec.match).WithYouTubeQuota(func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return until
	})

	// Trip: the first lookup fails on the quota, and the breaker opens.
	rec.setQuota(true)
	mu.Lock()
	until = time.Now().Add(time.Hour)
	mu.Unlock()
	winAdd(t, h, "q0", "q1")
	time.Sleep(100 * time.Millisecond)
	if n := len(rec.looked()); n != 0 {
		t.Fatalf("%d lookups launched while the quota is exhausted", n)
	}
	st := winState(t, h)
	if st.NowPlayingID == "" || st.Queue[0].Title != "q0" {
		t.Fatalf("sourceless now-playing was skipped during a quota outage: %+v", st.Queue)
	}
	if !st.Queue[0].YTQuota || !st.Queue[0].EnrichUncertain {
		t.Fatalf("q0 must be owed and uncertain, got %+v", st.Queue[0])
	}

	// Reset: the next activity retries both.
	rec.setQuota(false)
	mu.Lock()
	until = time.Time{}
	mu.Unlock()
	if _, err := h.mutate(winRoom, func(s *queue.RoomState) error { s.Version++; return nil }); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "retried after reset", func() bool { return winHasYT(t, h, "q0") && winHasYT(t, h, "q1") })
}

// A lookup that fails on the quota stays retryable and republishes the state
// (version bump) so clients get the quota notice.
func TestYouTubeWindowQuotaFailureSettlesRetryable(t *testing.T) {
	rec := &ytRecorder{quota: true}
	var tripped atomic.Bool
	h := NewHub(nil).WithMatcher(func(ctx context.Context, title, a, i string) (*queue.SourceRef, error) {
		tripped.Store(true) // the real matcher opens the breaker before failing
		return rec.match(ctx, title, a, i)
	}).WithYouTubeQuota(func() time.Time {
		if tripped.Load() {
			return time.Now().Add(time.Hour)
		}
		return time.Time{}
	})
	var pubMu sync.Mutex
	var versions []int64
	h.publishFn = func(_ string, state json.RawMessage) error {
		var s queue.RoomState
		_ = json.Unmarshal(state, &s)
		pubMu.Lock()
		versions = append(versions, s.Version)
		pubMu.Unlock()
		return nil
	}
	winAdd(t, h, "z0")
	waitFor(t, "quota settle", func() bool {
		tr := winState(t, h).Queue[0]
		return tr.YTQuota && tr.EnrichPending == 0
	})
	tr := winState(t, h).Queue[0]
	if tr.EnrichChecked || !tr.EnrichUncertain || tr.YTLookup {
		t.Fatalf("quota failure must not mark the track checked: %+v", tr)
	}
	pubMu.Lock()
	defer pubMu.Unlock()
	if len(versions) < 2 || versions[len(versions)-1] <= versions[0] {
		t.Fatalf("expected a version bump after the quota failure, got %v", versions)
	}
}

// Outbound state carries the quota reset time while exhausted, and persisted
// state never does.
func TestYouTubeQuotaStampedOnOutboundState(t *testing.T) {
	until := time.Now().Add(time.Hour)
	h := NewHub(nil).WithMatcher(func(context.Context, string, string, string) (*queue.SourceRef, error) {
		return nil, nil
	}).WithYouTubeQuota(func() time.Time { return until })
	data, err := h.mutate(winRoom, func(s *queue.RoomState) error { s.Version++; return nil })
	if err != nil {
		t.Fatal(err)
	}
	var out queue.RoomState
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	if out.YouTubeQuotaUntil != until.UnixMilli() {
		t.Fatalf("youtubeQuotaUntil = %d, want %d", out.YouTubeQuotaUntil, until.UnixMilli())
	}
	if winState(t, h).YouTubeQuotaUntil != 0 {
		t.Fatal("shared room state must not carry the quota stamp")
	}
}

// A short pause pauses searches but is not stamped for clients; the daily
// quota is. The wake-up timer is armed for both so owed lookups retry.
func TestYouTubeQuotaTransientPauseNotStamped(t *testing.T) {
	until := time.Now().Add(time.Hour)
	var daily atomic.Bool
	h := NewHub(nil).WithMatcher(func(context.Context, string, string, string) (*queue.SourceRef, error) {
		return nil, nil
	}).WithYouTubeQuota(func() time.Time { return until }).WithYouTubeQuotaNotice(func() time.Time {
		if daily.Load() {
			return until
		}
		return time.Time{}
	})
	defer h.BeginShutdown()
	stamp := func() int64 {
		data, err := h.mutate(winRoom, func(s *queue.RoomState) error { s.Version++; return nil })
		if err != nil {
			t.Fatal(err)
		}
		var out queue.RoomState
		_ = json.Unmarshal(data, &out)
		return out.YouTubeQuotaUntil
	}
	if got := stamp(); got != 0 {
		t.Fatalf("transient pause stamped %d, want 0", got)
	}
	h.quotaWake.mu.Lock()
	armed := h.quotaWake.timer != nil
	h.quotaWake.mu.Unlock()
	if !armed {
		t.Fatal("wake-up timer should be armed for a pause")
	}
	daily.Store(true)
	if got := stamp(); got != until.UnixMilli() {
		t.Fatalf("daily quota stamped %d, want %d", got, until.UnixMilli())
	}
}
