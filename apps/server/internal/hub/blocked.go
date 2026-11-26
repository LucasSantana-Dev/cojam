package hub

import (
	"github.com/centrifugal/centrifuge"
)

// Operator block of one person across every room (#259). Closing a room
// (closed.go) stops the room; `server person --block` stops the person. It
// records the identity in person_blocks and the server applies it here within
// one poll (restrict.WatchBlocked). A blocked identity:
//
//   - has every open connection ended with DisconnectUserBlocked, whatever
//     room it is in;
//   - is refused at connect (cmd/server OnConnecting), and on every subscribe
//     and room-scoped RPC in case a connection slipped in before the poll.
//
// The identity is the connection's userID: "sb:<uuid>" for an account, the
// guest id otherwise. A block stops that identity, not the person: a blocked
// account holder can still come in as a guest, and a guest can start over
// with a fresh guest id.

// DisconnectUserBlocked is the terminal disconnect for a blocked person.
// Codes 4500-4999 are application terminal codes (centrifuge-js does not
// reconnect); the web client maps 4502 to its "access blocked" state.
var DisconnectUserBlocked = centrifuge.Disconnect{Code: 4502, Reason: "access blocked"}

// IsUserBlocked reports whether the operator blocked userID. The empty
// identity (room auth off) is never blocked: it names nobody.
func (h *Hub) IsUserBlocked(userID string) bool {
	if userID == "" {
		return false
	}
	h.blockedMu.RLock()
	defer h.blockedMu.RUnlock()
	_, blocked := h.blockedUsers[userID]
	return blocked
}

// IsClientBlocked reports whether the identity behind clientID is blocked.
func (h *Hub) IsClientBlocked(clientID string) bool {
	return h.IsUserBlocked(h.userIDOf(clientID))
}

// SetBlockedUsers replaces the blocked set with ids (the full list from the
// database, not a delta) and disconnects every connection of a newly blocked
// identity. An identity removed from the list (`server person --unblock`)
// can simply connect again.
func (h *Hub) SetBlockedUsers(ids []string) {
	next := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if id != "" {
			next[id] = struct{}{}
		}
	}
	h.blockedMu.Lock()
	prev := h.blockedUsers
	h.blockedUsers = next
	h.blockedMu.Unlock()

	for id := range next {
		if _, was := prev[id]; !was {
			h.disconnectUser(id)
		}
	}
}

// disconnectUser ends every connection carrying userID. Membership cleanup
// runs on each connection's own disconnect path (Leave, host handoff), as for
// any other disconnect.
func (h *Hub) disconnectUser(userID string) {
	if h.node == nil {
		return
	}
	conns := h.node.Hub().UserConnections(userID)
	for _, c := range conns {
		c.Disconnect(DisconnectUserBlocked)
	}
	if h.logger != nil && len(conns) > 0 {
		// The identity is not logged: the block row already names it, and
		// logs are wider than the database.
		h.logger.Info("person_blocked_by_operator", "connections_disconnected", len(conns))
	}
}

// Subject is what the server itself knows about whoever a report names, as
// opposed to the content and reason the reporter typed.
type Subject struct {
	// Sub is the connection identity; "" when it could not be resolved.
	Sub string
	// Name is the display name the server had for the connection or line.
	Name string
	// Text is the chat line as the server stored it (message reports only).
	Text string
}

// ReportSubject resolves who a report is about, so the operator can block
// that person later (`server person --report`). A member report names a
// connection id, which must still be a member of the room; a message report
// names a chat line, which must still be in the resident room's ring.
// Anything else, or a subject already gone, resolves to the zero Subject:
// the report is stored either way.
func (h *Hub) ReportSubject(roomID, kind, subjectID string) Subject {
	if subjectID == "" {
		return Subject{}
	}
	switch kind {
	case "member":
		if !h.IsMember(subjectID, roomID) {
			return Subject{}
		}
		return Subject{Sub: h.userIDOf(subjectID), Name: h.displayName(subjectID)}
	case "message":
		h.mu.RLock()
		room, ok := h.rooms[roomID]
		h.mu.RUnlock()
		if !ok {
			return Subject{}
		}
		room.mu.Lock()
		defer room.mu.Unlock()
		for _, m := range room.chat {
			if m.ID == subjectID && !m.Deleted {
				return Subject{Sub: m.UserID, Name: m.Name, Text: m.Text}
			}
		}
	}
	return Subject{}
}
