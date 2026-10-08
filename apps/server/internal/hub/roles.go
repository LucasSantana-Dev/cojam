package hub

import (
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// DefaultHostGrace is how long a disconnected host keeps the role before the
// longest-present member is promoted. A deploy restart, a page refresh or a
// flaky network drops the connection for seconds, not a minute; handing the
// room away on every blip cost an owner their own room (2026-10-08).
const DefaultHostGrace = 60 * time.Second

// timerStopper is the slice of *time.Timer the grace logic needs, so tests can
// inject a fake clock.
type timerStopper interface{ Stop() bool }

type graceEntry struct {
	userID string
	timer  timerStopper
}

// roleState holds the host-grace, shutdown and auto-skip settings. Zero value
// is the legacy behaviour: no grace (promote at once), no auto skip.
type roleState struct {
	hostGrace    time.Duration
	startedAt    time.Time
	shuttingDown atomic.Bool
	autoSkip     bool
	afterFunc    func(d time.Duration, f func()) timerStopper // test seam; nil = time.AfterFunc

	graceMu sync.Mutex
	graces  map[string]*graceEntry // roomID -> pending promotion
}

func (r *roleState) after(d time.Duration, f func()) timerStopper {
	if r.afterFunc != nil {
		return r.afterFunc(d, f)
	}
	return time.AfterFunc(d, f)
}

// WithHostGrace enables the host grace period (<= 0 keeps immediate
// promotion). It also starts the boot window: right after a restart the
// persisted host is held for the same period, so the first member to
// reconnect does not claim a room whose host is merely still reconnecting.
func (h *Hub) WithHostGrace(d time.Duration) *Hub {
	h.roles.hostGrace = d
	h.roles.startedAt = time.Now()
	return h
}

// WithAutoSkipSourceless makes the hub advance past a now-playing track that
// has no playable source once every lookup for it has finished.
func (h *Hub) WithAutoSkipSourceless(on bool) *Hub {
	h.roles.autoSkip = on
	return h
}

// BeginShutdown must run before the node shuts down. Every client disconnect
// that follows is the server going away, not the member leaving, so no host
// is promoted and pending grace timers are dropped.
func (h *Hub) BeginShutdown() {
	h.roles.shuttingDown.Store(true)
	h.roles.graceMu.Lock()
	for id, e := range h.roles.graces {
		e.timer.Stop()
		delete(h.roles.graces, id)
	}
	h.roles.graceMu.Unlock()
}

// canControlQueue is the one permission check for queue and transport
// control. Host-less rooms are equal-member only when host assignment is off.
func canControlQueue(s *queue.RoomState, userID string, hostAssignment bool) bool {
	if s.CanControl(userID) {
		return true
	}
	return s.HostUserID == "" && !hostAssignment
}

// controlAllows reports whether userID may run a queue or transport action in
// roomID. Same loading rules as hostAllows; never creates a room.
func (h *Hub) controlAllows(roomID, userID string) (bool, error) {
	room, err := h.getOrLoadRoom(roomID, false)
	if err != nil {
		return false, err
	}
	if room == nil {
		return !h.hostAssignment, nil
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	return canControlQueue(room.State, userID, h.hostAssignment), nil
}

// scheduleHostGrace arms the promotion timer for roomID's departed host,
// replacing any pending one.
func (h *Hub) scheduleHostGrace(roomID, hostUserID string) {
	r := &h.roles
	r.graceMu.Lock()
	defer r.graceMu.Unlock()
	if r.graces == nil {
		r.graces = make(map[string]*graceEntry)
	}
	if old, ok := r.graces[roomID]; ok {
		old.timer.Stop()
	}
	e := &graceEntry{userID: hostUserID}
	e.timer = r.after(r.hostGrace, func() { h.expireHostGrace(roomID, e) })
	r.graces[roomID] = e
}

// cancelHostGrace drops the pending promotion when userID is the held host
// (it rejoined) so the role stays put.
func (h *Hub) cancelHostGrace(roomID, userID string) {
	if userID == "" {
		return
	}
	r := &h.roles
	r.graceMu.Lock()
	defer r.graceMu.Unlock()
	if e, ok := r.graces[roomID]; ok && e.userID == userID {
		e.timer.Stop()
		delete(r.graces, roomID)
	}
}

// graceActive reports whether roomID is holding the host role for userID.
func (h *Hub) graceActive(roomID, userID string) bool {
	r := &h.roles
	r.graceMu.Lock()
	defer r.graceMu.Unlock()
	e, ok := r.graces[roomID]
	return ok && e.userID == userID
}

// hostHeld reports whether a join may not claim the absent host's role: a
// grace window is open, or the server just booted and the host has not had
// time to reconnect (in which case a window is opened now).
func (h *Hub) hostHeld(roomID, hostUserID string) bool {
	if h.roles.shuttingDown.Load() {
		return true
	}
	if h.graceActive(roomID, hostUserID) {
		return true
	}
	if g := h.roles.hostGrace; g > 0 && time.Since(h.roles.startedAt) < g {
		h.scheduleHostGrace(roomID, hostUserID)
		return true
	}
	return false
}

// expireHostGrace runs when the grace window closes. The entry identity check
// makes a cancelled or replaced timer a no-op even if it already fired.
func (h *Hub) expireHostGrace(roomID string, e *graceEntry) {
	r := &h.roles
	r.graceMu.Lock()
	if cur, ok := r.graces[roomID]; !ok || cur != e {
		r.graceMu.Unlock()
		return
	}
	delete(r.graces, roomID)
	r.graceMu.Unlock()
	if r.shuttingDown.Load() {
		return
	}
	successor, others := h.selectSuccessor(roomID, "")
	if !others {
		return // nobody left to hand it to; a later joiner claims it
	}
	h.commitHostHandoff(roomID, e.userID, successor)
}

// isOwner reports whether userID owns the (resident) room.
func (h *Hub) isOwner(roomID, userID string) bool {
	if userID == "" {
		return false
	}
	h.mu.RLock()
	room, ok := h.rooms[roomID]
	h.mu.RUnlock()
	if !ok {
		return false
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	return room.State.OwnerUserID == userID
}

// setAdmin grants or revokes admin. Caller already passed requireHost.
func (h *Hub) setAdmin(roomID, callerID, targetID string, admin bool) (json.RawMessage, error) {
	if targetID == "" {
		return nil, userErrorf("user id required")
	}
	if targetID == callerID {
		return nil, userErrorf("you cannot change your own role")
	}
	res, err := h.mutate(roomID, func(s *queue.RoomState) error {
		if s.OwnerUserID != "" && targetID == s.OwnerUserID {
			return userErrorf("the room owner cannot be changed")
		}
		changed, full := s.SetAdmin(targetID, admin)
		if full {
			return userErrorf("too many admins (max %d)", queue.MaxAdmins)
		}
		if changed {
			s.Version++
		}
		return nil
	})
	if err == nil && h.logger != nil {
		h.logger.Info("room_admin_set", "room_id", roomID, "by", callerID, "target", targetID, "admin", admin)
	}
	return res, err
}

// transferHost hands the host role to a member who is present right now.
func (h *Hub) transferHost(roomID, callerID, targetID string) (json.RawMessage, error) {
	if targetID == "" {
		return nil, userErrorf("user id required")
	}
	if !h.IsUserIDInRoom(roomID, targetID) {
		return nil, userErrorf("that member is not in this room")
	}
	res, err := h.mutate(roomID, func(s *queue.RoomState) error {
		if s.HostUserID == targetID {
			return nil
		}
		if !h.IsUserIDInRoom(roomID, targetID) {
			return userErrorf("that member is not in this room")
		}
		s.HostUserID = targetID
		s.Version++
		return nil
	})
	if err == nil && h.logger != nil {
		h.logger.Info("room_host_transferred", "room_id", roomID, "by", callerID, "target", targetID)
	}
	return res, err
}

// enrichBookkeeping returns how many source lookups queue.add / import /
// radio will launch for t, so the track can be marked pending in the same
// mutation that adds it (before any lookup can finish).
func (h *Hub) enrichBookkeeping(t *queue.TrackRef) {
	n := 0
	if h.matcher != nil && t.Sources.YouTube == nil {
		n++
	}
	if h.spotifyMatcher != nil && t.Sources.Spotify == nil {
		n++
	}
	t.EnrichPending = n
}

// launchTrackEnrich launches one lookup for a track counted by
// enrichBookkeeping. When the lookup ends (or the launch is dropped) the
// pending count falls and the sourceless check runs.
func (h *Hub) launchTrackEnrich(roomID, trackID string, fn func() (certain bool)) {
	if !h.launchEnrich(func() {
		h.enrichDone(roomID, trackID, fn())
	}) {
		h.enrichDone(roomID, trackID, false)
	}
}

// enrichDone settles one lookup. certain is false when the lookup errored
// rather than cleanly missing, which blocks the auto skip for that track: an
// outage must not drain a queue.
func (h *Hub) enrichDone(roomID, trackID string, certain bool) {
	_, _ = h.mutate(roomID, func(s *queue.RoomState) error {
		if t := s.Track(trackID); t != nil {
			if t.EnrichPending > 0 {
				t.EnrichPending--
			}
			if !certain {
				t.EnrichUncertain = true
			}
		}
		return nil
	})
}

// autoSkipSourceless advances past now-playing tracks that can never play:
// no source on any service and no lookup left in flight. Bounded by the
// queue length so a fully sourceless queue ends instead of looping.
func (h *Hub) autoSkipSourceless(roomID string) {
	if !h.roles.autoSkip {
		return
	}
	for i := 0; i < queue.MaxQueueSize+1; i++ {
		h.mu.RLock()
		room, ok := h.rooms[roomID]
		h.mu.RUnlock()
		if !ok {
			return
		}
		var stuckID, title string
		room.mu.Lock()
		if t := room.State.Track(room.State.NowPlayingID); t != nil &&
			!t.HasSource() && t.EnrichPending == 0 && !t.EnrichUncertain {
			stuckID, title = t.ID, t.Title
		}
		room.mu.Unlock()
		if stuckID == "" {
			return
		}
		if h.logger != nil {
			h.logger.Info("auto_skip_sourceless", "room_id", roomID, "track_id", stuckID, "title", title)
		}
		if _, err := h.advanceAfter(roomID, stuckID, false); err != nil {
			return
		}
	}
}
