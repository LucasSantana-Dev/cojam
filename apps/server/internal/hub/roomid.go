package hub

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"

	"github.com/centrifugal/centrifuge"
)

// roomIDRe matches the ids the web app mints: 12 uppercase base36 chars from
// apps/web/lib/roomId.ts, plus the shorter legacy ids (up to 6 chars) the
// pre-#180 generator produced and that existing links still carry. One
// pattern, enforced at every transport entry (Authorize, channel subscribe).
var roomIDRe = regexp.MustCompile(`^[0-9A-Z]{1,12}$`)

// ValidRoomID reports whether id is a well-formed room id.
func ValidRoomID(id string) bool {
	return roomIDRe.MatchString(id)
}

// roomChannelPrefix is the only channel namespace clients may subscribe to.
const roomChannelPrefix = "room:"

// RoomIDFromChannel returns the room id of a "room:<id>" channel, and false
// for any other channel or a malformed id. Subscriptions to anything else are
// refused, so clients cannot open arbitrary channels with presence.
func RoomIDFromChannel(channel string) (string, bool) {
	id, ok := strings.CutPrefix(channel, roomChannelPrefix)
	if !ok || !ValidRoomID(id) {
		return "", false
	}
	return id, true
}

// errInvalidRoomID is the client-visible rejection for a malformed roomId.
var errInvalidRoomID = &centrifuge.Error{Code: 400, Message: "invalid room id"}

// Defaults for the room.join limiter (per caller). Joins re-run on every
// reconnect, so the burst is generous; tests shrink h.joinLimiter.
const (
	joinBurst  = 10
	joinRefill = 2 * time.Second
)

// Defaults for the room-creation budget (per caller): only RPCs that would
// create a room missing from memory and the store draw from it, so joining an
// existing room never does. Tests shrink h.roomCreateLimiter.
const (
	roomCreateBurst  = 10
	roomCreateRefill = time.Minute
)

// checkJoinLimit enforces the per-caller bucket on room.join.
func (h *Hub) checkJoinLimit(method, rlKey string) error {
	if method != "room.join" || h.joinLimiter == nil {
		return nil
	}
	if !h.joinLimiter.allow(rlKey) {
		if h.metrics != nil {
			h.metrics.RateLimitReject(method)
		}
		return userErrorf("too many requests, slow down")
	}
	return nil
}

// ensureRoom resolves the target room of a room-scoped RPC before dispatch,
// charging the caller's creation budget only when the room exists neither in
// memory nor in the store. Afterwards the room is resident, so dispatch's own
// GetOrCreateRoom is a cache hit. Non-room-scoped methods pass through.
func (h *Hub) ensureRoom(method string, data []byte, clientID, rlKey string) error {
	if method != "room.join" && !mutatingMethods[method] {
		return nil
	}
	var probe struct {
		RoomID string `json:"roomId"`
	}
	if json.Unmarshal(data, &probe) != nil || probe.RoomID == "" {
		return nil // dispatch owns malformed-payload and roomId-required errors
	}
	room, err := h.getOrLoadRoom(probe.RoomID, false)
	if err != nil || room != nil {
		return err
	}
	if h.roomCreateLimiter != nil && !h.roomCreateLimiter.allow(rlKey) {
		if h.metrics != nil {
			h.metrics.RateLimitReject(method)
		}
		return userErrorf("too many new rooms, try again later")
	}
	_, err = h.GetOrCreateRoom(probe.RoomID)
	return err
}
