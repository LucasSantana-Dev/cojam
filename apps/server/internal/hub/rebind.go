package hub

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/connauth"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// Guest-to-account upgrade (#172, spec docs/specs/172-guest-account-upgrade.md,
// ADR-0005). room.rebind moves a guest's attribution inside the current room
// (track ownership, host role, vote keys, join-time seniority) from their
// anonymous sub to their authenticated "sb:<uuid>" identity. The request
// carries only the room and the stored anonymous connection JWT: holding the
// server-signed token is the ownership proof (the same trust model the
// token-refresh path ships), so the client can never name another guest's
// identity. A successful rebind burns the sub (single-use) and
// force-disconnects the rebound sub's remaining connections.

// roomRebind executes one guest-to-account rebind. Guards run before any
// mutation: the caller must be authenticated (something to upgrade to), the
// proof must verify (something to upgrade from), the account must not already
// be in the room on another connection (collision, decision B), and the sub
// must be unconsumed (burn, decision C).
func (h *Hub) roomRebind(roomID, proof, clientID, userID string) (json.RawMessage, error) {
	if !strings.HasPrefix(userID, "sb:") {
		return nil, userErrorf("room.rebind requires a signed-in account")
	}
	if proof == "" {
		return nil, userErrorf("guest proof token required")
	}
	oldSub, err := connauth.ValidateForRefresh(h.rebindSecret, proof, connauth.RefreshGrace)
	if err != nil {
		return nil, userErrorf("guest proof could not be verified")
	}
	if h.isUserIDInRoomExcept(roomID, userID, clientID) {
		return nil, userErrorf("This account is already in this room from another tab or device. Close it and retry.")
	}

	// One mutation for the whole reattribution: the burn lands at commit
	// inside the same closure (Claim is atomic, so a concurrent rebind with
	// the same proof loses), then one Version bump publishes one state.
	res, err := h.mutate(roomID, func(s *queue.RoomState) error {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		claimed, err := h.rebindBurns.Claim(ctx, oldSub)
		if err != nil {
			return err
		}
		if !claimed {
			return userErrorf("this guest identity was already upgraded")
		}
		for i := range s.Queue {
			if s.Queue[i].AddedByUserID == oldSub {
				s.Queue[i].AddedByUserID = userID
			}
		}
		if s.HostUserID == oldSub {
			s.HostUserID = userID
		}
		s.RewriteVoter("user:"+oldSub, "user:"+userID)
		s.Version++ // exactly one bump for the whole rebind (#172)
		return nil
	})
	if err != nil {
		return nil, err
	}

	h.transferJoinTime(roomID, oldSub, userID)
	h.disconnectReboundSub(roomID, oldSub)
	if h.logger != nil {
		h.logger.Info("room_rebound", "room_id", roomID)
	}
	return res, nil
}

// isUserIDInRoomExcept reports whether userID has a member connection in the
// room other than exceptClientID. The rebind collision check (decision B)
// excludes the caller's own connection: the caller is always a member.
func (h *Hub) isUserIDInRoomExcept(roomID, userID, exceptClientID string) bool {
	h.memberMu.RLock()
	defer h.memberMu.RUnlock()
	h.clientUserIDMu.RLock()
	defer h.clientUserIDMu.RUnlock()
	for cid := range h.roomMembers[roomID] {
		if cid != exceptClientID && h.clientUserID[cid] == userID {
			return true
		}
	}
	return false
}

// transferJoinTime moves the rebound sub's join timestamp to the
// authenticated identity (#172), keeping the earlier of the two so the
// upgraded member keeps longest-present standing for host promotion (#166)
// instead of restarting at the rebind instant.
func (h *Hub) transferJoinTime(roomID, oldSub, userID string) {
	h.memberMu.Lock()
	defer h.memberMu.Unlock()
	times := h.memberJoinTimes[roomID]
	if times == nil {
		return
	}
	old, ok := times[oldSub]
	if !ok {
		return
	}
	if cur, exists := times[userID]; !exists || old < cur {
		times[userID] = old
	}
	delete(times, oldSub)
}

// disconnectReboundSub force-disconnects the rebound sub's remaining member
// connections via the room.kick mechanism (#172): without it a still-open
// anonymous tab keeps accumulating attribution under the dead sub (the
// multi-tab zombie from spec section 6).
func (h *Hub) disconnectReboundSub(roomID, oldSub string) {
	h.memberMu.RLock()
	candidates := make([]string, 0, len(h.roomMembers[roomID]))
	for cid := range h.roomMembers[roomID] {
		candidates = append(candidates, cid)
	}
	h.memberMu.RUnlock()

	for _, cid := range candidates {
		h.clientUserIDMu.RLock()
		uid := h.clientUserID[cid]
		h.clientUserIDMu.RUnlock()
		if uid != oldSub {
			continue
		}
		if _, err := h.roomKick(roomID, cid); err != nil && h.logger != nil {
			h.logger.Info("rebind_zombie_disconnect_failed", "room_id", roomID, "client_id", cid, "err", err.Error())
		}
	}
}
