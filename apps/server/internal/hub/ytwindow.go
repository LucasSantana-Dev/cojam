package hub

import (
	"errors"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// youtubeMatchWindow is how many tracks (now playing first, then the next in
// queue order) get a YouTube lookup. YouTube search costs 100 of the 10,000
// daily quota units, so a bulk import or a radio refill must not search for
// every track at once. Tracks further back stay un-enriched for YouTube until
// they enter the window; Spotify matching stays eager (no such quota).
const youtubeMatchWindow = 3

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

// quotaUntilMs is quotaUntil as unix ms for the wire (0 = available).
func (h *Hub) quotaUntilMs() int64 {
	if u := h.quotaUntil(); !u.IsZero() {
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
		if t.YTQuota {
			t.EnrichUncertain, t.YTQuota = false, false
		}
		t.YTLookup = true
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
