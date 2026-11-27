package hub

import "github.com/LucasSantana-Dev/cojam/server/internal/queue"

// Features is the set of feature gates the operator can change while the
// server runs (internal/flags, migration 0012). Each field matches a With*
// option, which keeps setting the boot value.
type Features struct {
	Sync        bool
	Voting      bool
	Chat        bool
	PublicRooms bool
	Video       bool
	ScreenShare bool
	// ScreenAllowlist limits shares to these rooms; nil or empty = every
	// eligible private room.
	ScreenAllowlist []string
}

// SetFeatures applies a new set of gates. Every RPC reads its gate on each
// call, so the change reaches the next call. Screen share is the one gate
// with live state: turning it off ends every live share, and narrowing the
// allowlist ends the shares in rooms it no longer lists, with the usual
// trail, metrics and chat line (reason "disabled").
func (h *Hub) SetFeatures(f Features) {
	h.syncEnabled.Store(f.Sync)
	h.votingEnabled.Store(f.Voting)
	h.chatEnabled.Store(f.Chat)
	h.publicRoomsEnabled.Store(f.PublicRooms)
	h.videoEnabled.Store(f.Video)
	// Allowlist before the gate, so a share started in between already sees
	// the new list.
	prevEnabled := h.screen.enabled.Load()
	prevAllow := h.screen.allowlist.Load()
	nextAllow := screenAllowSet(f.ScreenAllowlist)
	h.screen.allowlist.Store(nextAllow)
	h.screen.enabled.Store(f.ScreenShare)
	// The poll applies every 15 s: sweep only when a change can end a share,
	// so an unchanged poll does not lock every resident room.
	if prevEnabled && (!f.ScreenShare || !sameAllowSet(prevAllow, nextAllow)) {
		h.endDisallowedShares()
	}
}

// sameAllowSet reports whether two allowlists admit the same rooms.
func sameAllowSet(a, b *map[string]struct{}) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	if len(*a) != len(*b) {
		return false
	}
	for id := range *a {
		if _, ok := (*b)[id]; !ok {
			return false
		}
	}
	return true
}

// endDisallowedShares ends each live share that the current gate or
// allowlist no longer permits.
func (h *Hub) endDisallowedShares() {
	enabled := h.screen.enabled.Load()
	h.mu.RLock()
	ids := make([]string, 0, len(h.rooms))
	for id := range h.rooms {
		ids = append(ids, id)
	}
	h.mu.RUnlock()
	for _, roomID := range ids {
		if enabled && h.screenAllowed(roomID) {
			continue
		}
		if !h.screenLive(roomID) {
			continue
		}
		h.screenDisable(roomID)
	}
}

// screenDisable ends roomID's share because the operator turned it off.
func (h *Hub) screenDisable(roomID string) {
	room := h.residentRoom(roomID)
	if room == nil {
		return
	}
	var ended *screenEnded
	_, err := h.mutateRoom(roomID, room, func(s *queue.RoomState) error {
		ended = h.endSessionLocked(room, roomID, screenEndDisabled, "")
		if ended != nil {
			s.Version++
		}
		return nil
	})
	if err != nil {
		if h.logger != nil {
			h.logger.Error("screen_disable_failed", "room_id", roomID, "err", err.Error())
		}
		return
	}
	if ended != nil {
		h.finishScreenSession(*ended, true)
	}
}
