package hub

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/centrifugal/centrifuge"
)

// joinAsHost creates a chat-enabled room whose host is the given userID
// (first authenticated joiner becomes host, #166) and returns the hub.
func newModerationTestHub(t *testing.T, roomID, hostUserID string) *Hub {
	t.Helper()
	h := newChatTestHub(t)
	payload := fmt.Sprintf(`{"roomId":%q,"name":"Host"}`, roomID)
	if _, err := h.HandleRPC("room.join", []byte(payload), hostUserID); err != nil {
		t.Fatalf("host room.join: %v", err)
	}
	return h
}

// sendChatLine sends one chat line and returns its server-stamped id.
func sendChatLine(t *testing.T, h *Hub, roomID, text string) string {
	t.Helper()
	payload := fmt.Sprintf(`{"roomId":%q,"text":%q,"name":"Ana"}`, roomID, text)
	res, err := h.HandleRPC("chat.send", []byte(payload), "")
	if err != nil {
		t.Fatalf("chat.send %q: %v", text, err)
	}
	var out struct {
		Message ChatMessage `json:"message"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		t.Fatalf("unmarshal send result: %v", err)
	}
	return out.Message.ID
}

func chatHistoryOf(t *testing.T, h *Hub, roomID string) []ChatMessage {
	t.Helper()
	res, err := h.HandleRPC("chat.history", []byte(fmt.Sprintf(`{"roomId":%q}`, roomID)), "")
	if err != nil {
		t.Fatalf("chat.history: %v", err)
	}
	var out struct {
		Messages []ChatMessage `json:"messages"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		t.Fatalf("unmarshal history: %v", err)
	}
	return out.Messages
}

// TestModeration_NonHostRejected pins the acceptance criterion: a non-host
// member calling either moderation RPC gets a client-visible UserError (code
// 400 via rpcClientError), and nothing is tombstoned or dropped.
func TestModeration_NonHostRejected(t *testing.T) {
	h := newModerationTestHub(t, "r", "u-host")
	msgID := sendChatLine(t, h, "r", "keep me")

	h.Join("c-troll", "r")
	h.RecordClientUserID("c-troll", "u-troll")

	del := []byte(fmt.Sprintf(`{"roomId":"r","messageId":%q}`, msgID))
	_, err := h.HandleRPC("chat.delete", del, "u-troll")
	var ue *UserError
	if !errors.As(err, &ue) {
		t.Fatalf("non-host chat.delete: got %v (%T), want a *UserError (client-visible 400)", err, err)
	}

	kick := []byte(`{"roomId":"r","clientId":"c-troll"}`)
	_, err = h.HandleRPC("room.kick", kick, "u-troll")
	if !errors.As(err, &ue) {
		t.Fatalf("non-host room.kick: got %v (%T), want a *UserError (client-visible 400)", err, err)
	}

	// The rejected attempts must be no-ops: the message survives and the
	// member is still enrolled.
	msgs := chatHistoryOf(t, h, "r")
	if len(msgs) != 1 || msgs[0].Deleted || msgs[0].Text != "keep me" {
		t.Fatalf("non-host delete mutated the ring: %+v", msgs)
	}
	if !h.IsMember("c-troll", "r") {
		t.Fatal("non-host kick dropped a membership")
	}
}

// TestChatDelete_TombstonesAndRedacts pins the tombstone semantics: the ring
// slot is kept (history is never rewritten) but the text is redacted, and the
// delete never touches RoomState.Version (chat is not room state).
func TestChatDelete_TombstonesAndRedacts(t *testing.T) {
	h := newModerationTestHub(t, "r", "u-host")
	first := sendChatLine(t, h, "r", "troll bait")
	second := sendChatLine(t, h, "r", "harmless")

	payload := fmt.Sprintf(`{"roomId":"r","messageId":%q}`, first)
	if _, err := h.HandleRPC("chat.delete", []byte(payload), "u-host"); err != nil {
		t.Fatalf("host chat.delete: %v", err)
	}

	msgs := chatHistoryOf(t, h, "r")
	if len(msgs) != 2 {
		t.Fatalf("history len = %d, want 2 (tombstone keeps the slot)", len(msgs))
	}
	if !msgs[0].Deleted {
		t.Fatal("deleted message must carry the tombstone flag")
	}
	if msgs[0].Text != "" {
		t.Fatalf("tombstone text must be redacted, got %q", msgs[0].Text)
	}
	if msgs[1].ID != second || msgs[1].Deleted || msgs[1].Text != "harmless" {
		t.Fatalf("sibling message must be untouched: %+v", msgs[1])
	}

	// Version discipline (chat is not RoomState): join was the last bump.
	res, err := h.HandleRPC("room.join", []byte(`{"roomId":"r","name":"Late"}`), "")
	if err != nil {
		t.Fatalf("rejoin: %v", err)
	}
	var st struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(res, &st); err != nil {
		t.Fatalf("unmarshal state: %v", err)
	}
	if st.Version != 1 {
		t.Fatalf("chat.delete bumped RoomState.Version: got %d, want 1 (host assignment only)", st.Version)
	}
}

// TestChatDelete_UnknownMessage rejects deleting what is not in the ring
// (already evicted, or a guessed id) with a client-visible UserError.
func TestChatDelete_UnknownMessage(t *testing.T) {
	h := newModerationTestHub(t, "r", "u-host")

	_, err := h.HandleRPC("chat.delete", []byte(`{"roomId":"r","messageId":"nope"}`), "u-host")
	var ue *UserError
	if !errors.As(err, &ue) {
		t.Fatalf("unknown message: got %v (%T), want a *UserError", err, err)
	}
	if ue.Error() != "message not found" {
		t.Fatalf("message = %q, want %q", ue.Error(), "message not found")
	}
}

// TestChatDelete_DisabledReturnsMethodNotFound pins the dark-ship default,
// same as chat.send.
func TestChatDelete_DisabledReturnsMethodNotFound(t *testing.T) {
	h := NewHub(nil)

	if _, err := h.HandleRPC("chat.delete", []byte(`{"roomId":"x","messageId":"m"}`), ""); !errors.Is(err, centrifuge.ErrorMethodNotFound) {
		t.Fatalf("chat.delete with chat off: got %v, want ErrorMethodNotFound", err)
	}
}

// TestModeration_MembershipGate pins both RPCs behind the same membership
// gate as mutations: a non-member guessing a room id is denied before dispatch.
func TestModeration_MembershipGate(t *testing.T) {
	h := NewHub(nil).WithChat(true)

	del := []byte(`{"roomId":"x","messageId":"m"}`)
	if err := h.Authorize(newTestClient("attacker", ""), "chat.delete", del); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("unjoined chat.delete: got %v, want ErrorPermissionDenied", err)
	}
	kick := []byte(`{"roomId":"x","clientId":"c1"}`)
	if err := h.Authorize(newTestClient("attacker", ""), "room.kick", kick); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("unjoined room.kick: got %v, want ErrorPermissionDenied", err)
	}

	// Members pass the membership gate (the host check itself lives in dispatch).
	h.Join("c1", "x")
	if err := h.Authorize(newTestClient("c1", ""), "chat.delete", del); err != nil {
		t.Fatalf("member chat.delete: got %v, want nil", err)
	}
	if err := h.Authorize(newTestClient("c1", ""), "room.kick", kick); err != nil {
		t.Fatalf("member room.kick: got %v, want nil", err)
	}
}

// TestRoomKick_DropsMembership pins the kick effect: the target's membership
// and user-presence are gone (the live presence leave rides centrifuge's
// disconnect path, which a nil-node test cannot observe). A repeat kick of an
// already-gone client is rejected as a user error, and a host cannot kick a
// client id that is not a member of THEIR room (cross-room disconnect guard).
func TestRoomKick_DropsMembership(t *testing.T) {
	h := newModerationTestHub(t, "r", "u-host")

	h.RecordClientUserID("c-troll", "u-troll")
	h.Join("c-troll", "r")
	if !h.IsMember("c-troll", "r") || !h.IsUserIDInRoom("r", "u-troll") {
		t.Fatal("setup: troll must be enrolled")
	}

	kick := []byte(`{"roomId":"r","clientId":"c-troll"}`)
	if _, err := h.HandleRPC("room.kick", kick, "u-host"); err != nil {
		t.Fatalf("host room.kick: %v", err)
	}

	if h.IsMember("c-troll", "r") {
		t.Fatal("kicked client must lose its membership")
	}
	if h.IsUserIDInRoom("r", "u-troll") {
		t.Fatal("kicked user must leave room presence")
	}

	// Repeat kick: the target is gone, so this is a user error, not a success.
	if _, err := h.HandleRPC("room.kick", kick, "u-host"); err == nil {
		t.Fatal("repeat kick of a non-member must be rejected")
	}
}

// TestRoomKick_CrossRoomRejected pins the scoping guard: a host of room "r"
// must not be able to disconnect a client that is only a member of room
// "other" (CodeRabbit #227).
func TestRoomKick_CrossRoomRejected(t *testing.T) {
	h := newModerationTestHub(t, "r", "u-host")

	h.RecordClientUserID("c-user", "u-user")
	h.Join("c-user", "other") // member of a different room only

	kick := []byte(`{"roomId":"r","clientId":"c-user"}`)
	if _, err := h.HandleRPC("room.kick", kick, "u-host"); err == nil {
		t.Fatal("kick of a non-member must be rejected")
	}
	if !h.IsMember("c-user", "other") {
		t.Fatal("cross-room kick must not disturb the other room's membership")
	}
}

// TestModeration_RateLimited pins both moderation RPCs drawing from the
// per-caller chat bucket: burst, then the shared "too many requests" UserError.
func TestModeration_RateLimited(t *testing.T) {
	h := newModerationTestHub(t, "r", "u-host")
	m1 := sendChatLine(t, h, "r", "one")
	m2 := sendChatLine(t, h, "r", "two")

	clock := &fakeClock{now: time.Now()}
	h.chatLimiter = newRateLimiter(2, time.Hour, clock.Now) // no refill during the test

	del := func(id string) error {
		payload := fmt.Sprintf(`{"roomId":"r","messageId":%q}`, id)
		_, err := h.HandleRPC("chat.delete", []byte(payload), "u-host")
		return err
	}
	if err := del(m1); err != nil {
		t.Fatalf("delete within burst: %v", err)
	}
	if err := del(m2); err != nil {
		t.Fatalf("second delete within burst: %v", err)
	}
	_, err := h.HandleRPC("chat.delete", []byte(`{"roomId":"r","messageId":"x"}`), "u-host")
	var ue *UserError
	if !errors.As(err, &ue) || ue.Error() != "too many requests, slow down" {
		t.Fatalf("burst+1 delete: got %v, want the rate-limit UserError", err)
	}

	// room.kick draws from the same bucket.
	h.chatLimiter = newRateLimiter(1, time.Hour, clock.Now)
	h.RecordClientUserID("c-x", "u-x")
	h.Join("c-x", "r")
	kick := []byte(`{"roomId":"r","clientId":"c-x"}`)
	if _, err := h.HandleRPC("room.kick", kick, "u-host"); err != nil {
		t.Fatalf("kick within burst: %v", err)
	}
	_, err = h.HandleRPC("room.kick", kick, "u-host")
	if !errors.As(err, &ue) || ue.Error() != "too many requests, slow down" {
		t.Fatalf("burst+1 kick: got %v, want the rate-limit UserError", err)
	}
}
