package hub

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Room chat (F8): ephemeral, in-memory only. Chat is conversational context,
// not room state, so it never enters queue.RoomState (no Version bump, no
// full-state fan-out per line) and never touches the store (no write-through
// per message, no retention obligations). A per-room ring plus a tiny
// per-message publication keeps the hot path cheap.
const (
	// maxChatHistory is the per-room ring cap; on overflow the oldest message
	// drops. Late joiners get the last maxChatHistory via chat.history.
	maxChatHistory = 50
	// maxChatTextLen caps message text (aligns with maxImportFieldLen).
	maxChatTextLen = 300
	// maxChatNameLen caps the client-supplied display name (same trust level
	// as TrackRef.AddedBy: display only, identity is server-stamped userID).
	maxChatNameLen = 60
)

// Defaults for the chat rate limiter: chat is the canonical spammable RPC, so
// sends draw from a per-caller token bucket (burst of messages, then one token
// per interval). Tests replace h.chatLimiter with a shrunken limiter instead
// of tuning these.
const (
	chatBurst  = 5               // messages a caller may fire at once
	chatRefill = 2 * time.Second // one token regained per interval
)

// chatMethods are the RPCs that draw from the chat limiter. chat.history is
// deliberately excluded: it is bounded (maxChatHistory), membership-gated, and
// called once per join/rejoin. Chat is also kept out of fanoutMethods: that
// budget protects third-party API quotas and chat never leaves the server.
var chatMethods = map[string]bool{
	"chat.send": true,
}

// ChatMessage is one room chat line. userID is always server-stamped from the
// connection identity, never trusted from params (the AddedByUserID pattern).
type ChatMessage struct {
	ID             string `json:"id"`
	RoomID         string `json:"roomId"`
	Name           string `json:"name"`
	UserID         string `json:"userId,omitempty"`
	Text           string `json:"text"`
	SentAtServerMs int64  `json:"sentAtServerMs"`
}

// appendChat appends msg to the room's ring, dropping the oldest entry when
// the ring is full. Callers must hold room.mu.
func (r *Room) appendChat(msg ChatMessage) {
	r.chat = append(r.chat, msg)
	if len(r.chat) > maxChatHistory {
		r.chat = r.chat[len(r.chat)-maxChatHistory:]
	}
}

// chatHistory returns a copy of the room's ring, oldest first. Callers must
// hold room.mu.
func (r *Room) chatHistory() []ChatMessage {
	msgs := make([]ChatMessage, len(r.chat))
	copy(msgs, r.chat)
	return msgs
}

// newChatMessage validates client input and stamps the server-owned fields.
// text must trim to 1..maxChatTextLen chars; name is trimmed and truncated to
// maxChatNameLen (a display label, not identity, so over-long input is capped
// rather than rejected). Violations are user-facing (UserError -> 400).
func newChatMessage(roomID, text, name, userID string) (ChatMessage, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return ChatMessage{}, userErrorf("message cannot be empty")
	}
	if len(text) > maxChatTextLen {
		return ChatMessage{}, userErrorf("message too long (max %d chars)", maxChatTextLen)
	}
	name = strings.TrimSpace(name)
	if len(name) > maxChatNameLen {
		name = name[:maxChatNameLen]
	}
	if name == "" {
		name = "Listener"
	}
	return ChatMessage{
		ID:             uuid.New().String(),
		RoomID:         roomID,
		Name:           name,
		UserID:         userID,
		Text:           text,
		SentAtServerMs: time.Now().UnixMilli(),
	}, nil
}

// checkChatLimit enforces the per-caller token bucket on chatMethods. Returns
// nil for unlimited methods.
func (h *Hub) checkChatLimit(method, rlKey string) error {
	if !chatMethods[method] || h.chatLimiter == nil {
		return nil
	}
	if !h.chatLimiter.allow(rlKey) {
		return userErrorf("too many requests, slow down")
	}
	return nil
}

// publishChat broadcasts one chat message on the room channel. The payload
// shares the channel with room.state publications and is distinguished by
// type. Like publish, a nil node (tests) skips. Published after the ring
// append but outside the room lock: two concurrent sends may publish out of
// append order, which clients tolerate (dedupe by id, history is the ring).
func (h *Hub) publishChat(roomID string, msg ChatMessage) error {
	if h.node == nil { // test mode
		return nil
	}
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]json.RawMessage{
		"type":    json.RawMessage(`"chat.message"`),
		"message": raw,
	})
	if err != nil {
		return err
	}
	_, err = h.node.Publish("room:"+roomID, payload)
	return err
}

// chatSend handles chat.send: validate, append to the ring, publish, and
// return the stamped message. The authoritative delivery to everyone
// (including the sender) is the chat.message publication; the RPC result is
// just the stamped message (reads/non-state responses return whatever JSON
// they need). No mutate: RoomState.Version and the store stay untouched.
func (h *Hub) chatSend(roomID, text, name, userID string) (json.RawMessage, error) {
	msg, err := newChatMessage(roomID, text, name, userID)
	if err != nil {
		return nil, err
	}
	room := h.GetOrCreateRoom(roomID)
	room.mu.Lock()
	room.appendChat(msg)
	room.mu.Unlock()
	if err := h.publishChat(roomID, msg); err != nil {
		return nil, err
	}
	return json.Marshal(map[string]ChatMessage{"message": msg})
}

// chatHistory handles chat.history: a copy of the ring, oldest first.
func (h *Hub) chatHistoryRPC(roomID string) (json.RawMessage, error) {
	room := h.GetOrCreateRoom(roomID)
	room.mu.Lock()
	msgs := room.chatHistory()
	room.mu.Unlock()
	return json.Marshal(map[string][]ChatMessage{"messages": msgs})
}
