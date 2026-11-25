package hub

import (
	"github.com/centrifugal/centrifuge"
)

// Operator room closure (#259). The terms promise the operator can end a room
// and block access; `server room --close` records it in room_restrictions and
// the server applies it here within one poll (restrict.Watch). A closed room:
//
//   - disconnects every connected member with DisconnectRoomClosed;
//   - drops out of memory and out of the public directory;
//   - refuses every later channel subscribe and room-scoped RPC with the same
//     terminal disconnect, so a link or a bookmark cannot bring it back.
//
// The persisted room row is left alone: the evidence lives in reports, held
// past retention by the same restriction row.

// DisconnectRoomClosed is the terminal disconnect for a closed room. Codes
// 4500-4999 are application terminal codes (centrifuge-js does not
// reconnect); the web client maps 4501 to its "room closed" state, next to
// 4500 for a host kick.
var DisconnectRoomClosed = centrifuge.Disconnect{Code: 4501, Reason: "room closed"}

// IsRoomClosed reports whether the operator closed roomID.
func (h *Hub) IsRoomClosed(roomID string) bool {
	h.closedMu.RLock()
	defer h.closedMu.RUnlock()
	_, closed := h.closedRooms[roomID]
	return closed
}

// SetClosedRooms replaces the closed set with ids (the full list from the
// database, not a delta) and ends every room that is newly closed. A room
// removed from the list (`server room --reopen`) simply accepts joins again.
// Malformed ids are ignored: they cannot name a room.
func (h *Hub) SetClosedRooms(ids []string) {
	next := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if ValidRoomID(id) {
			next[id] = struct{}{}
		}
	}
	h.closedMu.Lock()
	prev := h.closedRooms
	h.closedRooms = next
	h.closedMu.Unlock()

	for id := range next {
		if _, was := prev[id]; !was {
			h.endRoom(id)
		}
	}
}

// endRoom drops every membership in roomID, removes the room from memory and
// disconnects its members. Lock order is memberMu then h.mu, as in
// evictIdleRooms. Nothing is persisted: the store row stays as it was.
func (h *Hub) endRoom(roomID string) {
	h.memberMu.Lock()
	clients := make([]string, 0, len(h.roomMembers[roomID]))
	for clientID := range h.roomMembers[roomID] {
		clients = append(clients, clientID)
		delete(h.members[clientID], roomID)
		if len(h.members[clientID]) == 0 {
			delete(h.members, clientID)
		}
	}
	delete(h.roomMembers, roomID)
	delete(h.memberJoinTimes, roomID)
	h.mu.Lock()
	_, resident := h.rooms[roomID]
	delete(h.rooms, roomID)
	h.mu.Unlock()
	h.memberMu.Unlock()
	h.stopHeartbeat(roomID)

	if h.node != nil && len(clients) > 0 {
		conns := h.node.Hub().Connections()
		for _, clientID := range clients {
			if c, ok := conns[clientID]; ok {
				c.Disconnect(DisconnectRoomClosed)
			}
		}
	}
	if h.logger != nil && (resident || len(clients) > 0) {
		h.logger.Info("room_closed_by_operator", "room_id", roomID, "members_disconnected", len(clients))
	}
}
