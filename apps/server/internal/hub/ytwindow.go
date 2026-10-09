package hub

import (
	"errors"
	"sync"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// youtubeMatchWindow is how many tracks (now playing first, then the next in
// queue order) get a YouTube lookup. YouTube search costs 100 of the 10,000
// daily quota units, so a bulk import or a radio refill must not search for
// every track at once. Tracks further back stay un-enriched for YouTube until
// they enter the window; Spotify matching stays eager (no such quota).
const youtubeMatchWindow = 3

// youtubeMaxAttempts caps how often a window lookup that failed for a reason
// other than the quota (a 5xx, a timeout, a dropped launch) is re-claimed.
const youtubeMaxAttempts = 3

// ErrQuotaExhausted is wrapped by a YouTube matcher when the daily search
// quota is used up (or the circuit breaker is open). The hub keeps the track
// retryable instead of treating it as a clean miss.
var ErrQuotaExhausted = errors.New("youtube quota exhausted")

// quotaUntil is the time the YouTube quota resets, zero while searches are
// allowed or when no breaker is wired.
func (h *Hub) quotaUntil() time.Time {
	if h.ytQuotaUntil == nil {
		return time.Time{}
	}
	if u := h.ytQuotaUntil(); u.After(time.Now()) {
		return u
	}
	return time.Time{}
}

// noticeUntilMs is the quota reset as unix ms for the wire (0 = nothing to
// show). Only the daily quota counts when a notice view is wired.
func (h *Hub) noticeUntilMs() int64 {
	u := h.quotaUntil()
	if h.ytQuotaNotice != nil && !u.IsZero() {
		u = h.ytQuotaNotice()
	}
	if u.After(time.Now()) {
		return u.UnixMilli()
	}
	return 0
}

// markYouTubeWindowLocked claims, under the room lock the caller holds, every
// in-window track that lacks a YouTube source and has no lookup yet, and
// returns snapshots to launch once the lock is released. Claiming (YTLookup,
// EnrichPending) happens in the same critical section as the mutation that
// moved the window, so a track is never looked up twice and the sourceless
// auto skip never sees a now-playing track as "checked" before its lookup is
// accounted for.
//
// While the quota is exhausted nothing is launched; in-window tracks are
// marked uncertain and owed (YTQuota) so the auto skip does not drain the
// queue and the first mutation after the reset retries them.
func (h *Hub) markYouTubeWindowLocked(s *queue.RoomState) []queue.TrackRef {
	if h.matcher == nil || len(s.Queue) == 0 {
		return nil
	}
	exhausted := !h.quotaUntil().IsZero()
	var launches []queue.TrackRef
	seen := 0
	visit := func(t *queue.TrackRef) {
		seen++
		if t.Sources.YouTube != nil || t.YTLookup {
			return
		}
		if exhausted {
			t.EnrichUncertain, t.YTQuota = true, true
			return
		}
		if t.YTQuota || t.YTAttempts > 0 {
			t.EnrichUncertain, t.YTQuota = false, false
		}
		t.YTLookup = true
		t.YTAttempts++
		t.EnrichPending++
		launches = append(launches, *t)
	}
	if np := s.Track(s.NowPlayingID); np != nil {
		visit(np)
	}
	for i := range s.Queue {
		if seen >= youtubeMatchWindow {
			break
		}
		if s.Queue[i].ID == s.NowPlayingID {
			continue
		}
		visit(&s.Queue[i])
	}
	return launches
}

// launchYouTubeLookups starts the claimed lookups. A launch dropped by the
// admission bound settles as uncertain, like any other dropped enrichment.
func (h *Hub) launchYouTubeLookups(roomID string, tracks []queue.TrackRef) {
	for _, tr := range tracks {
		tr := tr
		if !h.launchEnrich(func() {
			certain, quota := h.enrichYouTube(roomID, tr.ID, tr)
			h.enrichSettle(roomID, tr.ID, certain, quota)
		}) {
			h.enrichSettle(roomID, tr.ID, false, false)
		}
	}
}

// ensureYouTubeWindow claims and launches the YouTube lookups the room owes,
// outside a mutation (mutateRoom already does this for every state change).
func (h *Hub) ensureYouTubeWindow(roomID string) {
	h.mu.RLock()
	room, ok := h.rooms[roomID]
	h.mu.RUnlock()
	if !ok {
		return
	}
	room.mu.Lock()
	launches := h.markYouTubeWindowLocked(room.State)
	room.mu.Unlock()
	h.launchYouTubeLookups(roomID, launches)
}

// quotaTimer wakes idle rooms at the quota reset: nothing else touches a room
// nobody is acting in, so its sourceless tracks would stay owed and its
// clients would keep the notice.
type quotaTimer struct {
	mu    sync.Mutex
	timer *time.Timer
	at    time.Time
}

// armQuotaTimer schedules one wake-up at the current quota reset, replacing a
// timer set for another instant. Harmless without a breaker or after shutdown.
func (h *Hub) armQuotaTimer() {
	until := h.quotaUntil()
	if until.IsZero() || h.roles.shuttingDown.Load() {
		return
	}
	qt := &h.quotaWake
	qt.mu.Lock()
	defer qt.mu.Unlock()
	if qt.timer != nil && qt.at.Equal(until) {
		return
	}
	if qt.timer != nil {
		qt.timer.Stop()
	}
	qt.at = until
	// A little past the reset so the breaker reads as closed when it fires.
	qt.timer = time.AfterFunc(time.Until(until)+20*time.Millisecond, h.onQuotaReset)
}

func (h *Hub) stopQuotaTimer() {
	qt := &h.quotaWake
	qt.mu.Lock()
	if qt.timer != nil {
		qt.timer.Stop()
		qt.timer = nil
	}
	qt.mu.Unlock()
}

// onQuotaReset runs at the reset: every live room republishes (the version
// bump drops the notice on clients) and its window retries the owed lookups.
// If the breaker was tripped again meanwhile it re-arms instead.
func (h *Hub) onQuotaReset() {
	qt := &h.quotaWake
	qt.mu.Lock()
	qt.timer = nil
	qt.mu.Unlock()
	if h.roles.shuttingDown.Load() {
		return
	}
	if !h.quotaUntil().IsZero() {
		h.armQuotaTimer()
		return
	}
	h.mu.RLock()
	ids := make([]string, 0, len(h.rooms))
	for id := range h.rooms {
		ids = append(ids, id)
	}
	h.mu.RUnlock()
	for _, id := range ids {
		_, _ = h.mutate(id, func(s *queue.RoomState) error {
			if s.Version > 0 {
				s.Version++
			}
			return nil
		})
	}
}
