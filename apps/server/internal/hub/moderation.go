package hub

import (
	"encoding/json"

	"github.com/centrifugal/centrifuge"
)

// Host moderation (#181): chat.delete tombstones a chat ring entry and
// room.kick disconnects a member, so one troll in a public room has a remedy.
// Both are membership-gated (mutatingMethods) and host-gated like the other
// host-only RPCs, but the host check lives here (requireHost) instead of the
// Authorize gate: a routine non-host attempt is a client-visible mistake
// (UserError, code 400), not a transport auth failure (PermissionDenied 103).
// Both draw from the per-caller chat rate limit (chatMethods) so a host cannot
// be scripted into spamming deletions/kicks.

// disconnectKicked is the terminal disconnect sent to a kicked connection.
// Codes 4500-4999 are application terminal codes: centrifuge-js does not
// reconnect, and the web client maps the code to its "removed by host" state.
var disconnectKicked = centrifuge.Disconnect{Code: 4500, Reason: "removed by host"}

// requireHost rejects a non-host caller with a client-visible UserError when
// the room has a host assigned. An empty HostUserID (room auth off) preserves
// v0 equal-member behavior, same as the Authorize host-only gate.
func (h *Hub) requireHost(roomID, userID, action string) error {
	if hostUserID := h.GetHostUserID(roomID); hostUserID != "" && userID != hostUserID {
		return userErrorf("only the host can %s", action)
	}
	return nil
}

// chatDelete tombstones a ring entry: the slot is kept (the ring is never
// rewritten, so late joiners see a stable history) but the text is redacted
// server-side — a history refetch must not resurrect deleted content. A
// chat.delete publication tells connected clients to drop it by id. No mutate:
// chat is ephemeral, so RoomState.Version and the store stay untouched.
func (h *Hub) chatDelete(roomID, messageID string) (json.RawMessage, error) {
	room, err := h.GetOrCreateRoom(roomID)
	if err != nil {
		return nil, err
	}
	room.mu.Lock()
	found := false
	for i := range room.chat {
		if room.chat[i].ID == messageID {
			room.chat[i].Deleted = true
			room.chat[i].Text = ""
			found = true
			break
		}
	}
	room.mu.Unlock()
	if !found {
		return nil, userErrorf("message not found")
	}
	if err := h.publishChatDelete(roomID, messageID); err != nil {
		return nil, err
	}
	if h.logger != nil {
		h.logger.Info("chat_deleted", "room_id", roomID, "message_id", messageID)
	}
	return json.Marshal(map[string]string{"messageId": messageID})
}

// publishChatDelete broadcasts a tombstone event on the room channel, sharing
// the channel with room.state/chat.message and distinguished by type. Like
// publish, a nil node (tests) skips.
func (h *Hub) publishChatDelete(roomID, messageID string) error {
	if h.node == nil { // test mode
		return nil
	}
	rawID, err := json.Marshal(messageID)
	if err != nil {
		if h.metrics != nil {
			h.metrics.PublishError()
		}
		return err
	}
	payload, err := json.Marshal(map[string]json.RawMessage{
		"type":      json.RawMessage(`"chat.delete"`),
		"messageId": rawID,
	})
	if err != nil {
		if h.metrics != nil {
			h.metrics.PublishError()
		}
		return err
	}
	_, err = h.node.Publish("room:"+roomID, payload)
	if err != nil && h.metrics != nil {
		h.metrics.PublishError()
	}
	return err
}

// roomKick drops the target connection's membership in the room and, when the
// node is live, closes that connection with the terminal "removed by host"
// disconnect: the kicked client stops (no reconnect) and shows an explicit
// state instead of silently rejoining. Closing the connection runs the normal
// OnDisconnect cleanup in main.go (host handoff, guest-vote prune, identity
// tracking); remaining members see the departure through centrifuge's presence
// leave event, so no custom publication is needed. The membership drop here is
// idempotent with Leave running on disconnect.
func (h *Hub) roomKick(roomID, targetClientID string) (json.RawMessage, error) {
	h.leaveRoom(targetClientID, roomID)
	if h.node != nil {
		if c, ok := h.node.Hub().Connections()[targetClientID]; ok {
			c.Disconnect(disconnectKicked)
		}
	}
	if h.logger != nil {
		h.logger.Info("member_kicked", "room_id", roomID, "client_id", targetClientID)
	}
	return json.Marshal(map[string]string{"clientId": targetClientID})
}
