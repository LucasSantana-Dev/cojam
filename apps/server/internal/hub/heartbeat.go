package hub

import (
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// Video heartbeat (#258). While a video track plays and is not paused, the
// room's state is republished every videoHeartbeatEvery with a bumped Version
// (version-guarded clients drop an unbumped publication). Clients that missed
// a publication converge on the next beat, and the drift loop keeps running
// against the unchanged transport fields. The transport block is NOT
// re-stamped, so the web useDriftCorrection effect (keyed on transport fields,
// #177) does not re-seek on every beat.
//
// One ticker goroutine per room, started and stopped by reconcileHeartbeat
// after every mutation. It exits on pause, track end, flag off, no members or
// room eviction, and StopHeartbeats ends them all (shutdown, tests).

const videoHeartbeatEvery = 10 * time.Second

// Defaults for the transport limiter: scrubbing is bursty (dragging a seek
// bar fires many seeks), so the burst is generous and the refill quick.
// Tests replace h.transportLimiter with a shrunken limiter.
const (
	transportBurst  = 20
	transportRefill = 250 * time.Millisecond
)

// transportMethods draw from transportLimiter. Kept out of fanoutMethods:
// that budget protects third-party quotas and transport never leaves the server.
var transportMethods = map[string]bool{
	"transport.play":  true,
	"transport.pause": true,
	"transport.seek":  true,
}

// checkTransportLimit enforces the per-caller bucket on transportMethods.
func (h *Hub) checkTransportLimit(method, rlKey string) error {
	if !transportMethods[method] || h.transportLimiter == nil {
		return nil
	}
	if !h.transportLimiter.allow(rlKey) {
		if h.metrics != nil {
			h.metrics.RateLimitReject(method)
		}
		return userErrorf("too many requests, slow down")
	}
	return nil
}

// shouldHeartbeat reports whether s is a playing, unpaused video. Caller
// holds the room lock (or owns s).
func shouldHeartbeat(s *queue.RoomState) bool {
	if s == nil || s.NowPlayingID == "" || s.Transport == nil || s.Transport.State != "playing" {
		return false
	}
	for i := range s.Queue {
		if s.Queue[i].ID == s.NowPlayingID {
			return s.Queue[i].Kind == queue.KindVideo
		}
	}
	return false
}

// roomWantsHeartbeat looks the room up without touching it (a touch would
// keep an otherwise idle room from eviction).
func (h *Hub) roomWantsHeartbeat(roomID string) (*Room, bool) {
	if !h.videoEnabled {
		return nil, false
	}
	h.mu.RLock()
	room := h.rooms[roomID]
	h.mu.RUnlock()
	if room == nil {
		return nil, false
	}
	room.mu.Lock()
	want := shouldHeartbeat(room.State)
	room.mu.Unlock()
	return room, want
}

// reconcileHeartbeat starts or stops the room's ticker to match its state.
// Idempotent; safe to call after any mutation or join.
func (h *Hub) reconcileHeartbeat(roomID string) {
	if !h.videoEnabled {
		return
	}
	_, want := h.roomWantsHeartbeat(roomID)
	if !want {
		h.stopHeartbeat(roomID)
		return
	}
	h.hbMu.Lock()
	defer h.hbMu.Unlock()
	if _, running := h.heartbeats[roomID]; running {
		return
	}
	stop := make(chan struct{})
	h.heartbeats[roomID] = stop
	every := h.heartbeatEvery
	if every <= 0 {
		every = videoHeartbeatEvery
	}
	go h.heartbeatLoop(roomID, every, stop)
}

// stopHeartbeat ends the room's ticker if one is running.
func (h *Hub) stopHeartbeat(roomID string) {
	h.hbMu.Lock()
	defer h.hbMu.Unlock()
	if stop, ok := h.heartbeats[roomID]; ok {
		close(stop)
		delete(h.heartbeats, roomID)
	}
}

// StopHeartbeats ends every running heartbeat (shutdown and tests).
func (h *Hub) StopHeartbeats() {
	h.hbMu.Lock()
	defer h.hbMu.Unlock()
	for id, stop := range h.heartbeats {
		close(stop)
		delete(h.heartbeats, id)
	}
}

// heartbeatCount reports running tickers (tests).
func (h *Hub) heartbeatCount() int {
	h.hbMu.Lock()
	defer h.hbMu.Unlock()
	return len(h.heartbeats)
}

func (h *Hub) heartbeatLoop(roomID string, every time.Duration, stop chan struct{}) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			if !h.heartbeatTick(roomID, stop) {
				return
			}
		}
	}
}

// heartbeatTick republishes one beat. Returns false when the loop must end:
// the room was evicted or emptied, or no longer plays an unpaused video.
func (h *Hub) heartbeatTick(roomID string, stop chan struct{}) bool {
	room, want := h.roomWantsHeartbeat(roomID)
	h.memberMu.RLock()
	members := h.hasMembersLocked(roomID)
	h.memberMu.RUnlock()
	if room == nil || !want || !members {
		h.endHeartbeat(roomID, stop)
		return false
	}
	_, err := h.mutateRoom(roomID, room, func(s *queue.RoomState) error {
		if !shouldHeartbeat(s) {
			return nil // raced a pause: no bump, loop ends on next reconcile
		}
		s.Version++
		return nil
	})
	if err != nil && h.logger != nil {
		h.logger.Error("video_heartbeat_failed", "room_id", roomID, "err", err.Error())
	}
	return true
}

// endHeartbeat deregisters this loop's own channel only (a newer ticker for
// the same room must not be removed by a stale loop).
func (h *Hub) endHeartbeat(roomID string, stop chan struct{}) {
	h.hbMu.Lock()
	defer h.hbMu.Unlock()
	if cur, ok := h.heartbeats[roomID]; ok && cur == stop {
		delete(h.heartbeats, roomID)
	}
}
