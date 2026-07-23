package hub

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

// newChatTestHub returns a chat-enabled hub with the limiter out of the way so
// dispatch tests can send freely. Rate-limit tests install their own limiter.
func newChatTestHub(t *testing.T) *Hub {
	t.Helper()
	h := NewHub(nil).WithChat(true)
	h.chatLimiter = nil
	return h
}

// TestChat_MembershipGate pins chat.send and chat.history behind the same
// membership gate as mutations: a non-member guessing a room id is denied
// before dispatch.
func TestChat_MembershipGate(t *testing.T) {
	h := NewHub(nil).WithChat(true)

	send := []byte(`{"roomId":"x","text":"hi","name":"a"}`)
	history := []byte(`{"roomId":"x"}`)

	if err := h.Authorize(newTestClient("attacker", ""), "chat.send", send); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("unjoined chat.send: got %v, want ErrorPermissionDenied", err)
	}
	if err := h.Authorize(newTestClient("attacker", ""), "chat.history", history); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("unjoined chat.history: got %v, want ErrorPermissionDenied", err)
	}

	// Members pass the gate (chat is every member's channel, not host-only).
	h.Join("c1", "x")
	if err := h.Authorize(newTestClient("c1", ""), "chat.send", send); err != nil {
		t.Fatalf("member chat.send: got %v, want nil", err)
	}
	if err := h.Authorize(newTestClient("c1", ""), "chat.history", history); err != nil {
		t.Fatalf("member chat.history: got %v, want nil", err)
	}
}

// TestChatSend_Validation covers input hygiene and server-side stamping: text
// trims and must be 1..300 chars, the name is trimmed and capped, and id /
// userId / sentAtServerMs are always server-owned (a spoofed userId in params
// is ignored).
func TestChatSend_Validation(t *testing.T) {
	h := newChatTestHub(t)

	for _, tc := range []struct {
		name string
		text string
	}{
		{"empty", ""},
		{"whitespace only", "   \n\t  "},
		{"over 300 chars", strings.Repeat("x", maxChatTextLen+1)},
	} {
		payload, _ := json.Marshal(map[string]string{"roomId": "v", "text": tc.text, "name": "a"})
		_, err := h.HandleRPC("chat.send", payload, "")
		var ue *UserError
		if !errors.As(err, &ue) {
			t.Fatalf("%s: got %v (%T), want a *UserError (client-visible 400)", tc.name, err, err)
		}
	}

	res, err := h.HandleRPC("chat.send",
		[]byte(`{"roomId":"v","text":"  hello room  ","name":"  Ana  ","userId":"spoofed"}`), "u1")
	if err != nil {
		t.Fatalf("valid send: %v", err)
	}
	var out struct {
		Message ChatMessage `json:"message"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	m := out.Message
	if m.ID == "" {
		t.Fatal("server must stamp an id")
	}
	if m.RoomID != "v" {
		t.Fatalf("roomId = %q, want v", m.RoomID)
	}
	if m.Text != "hello room" {
		t.Fatalf("text must be trimmed: got %q", m.Text)
	}
	if m.Name != "Ana" {
		t.Fatalf("name must be trimmed: got %q", m.Name)
	}
	if m.UserID != "u1" {
		t.Fatalf("userId must come from the connection, not params: got %q, want u1", m.UserID)
	}
	if m.SentAtServerMs <= 0 {
		t.Fatalf("sentAtServerMs must be stamped: got %d", m.SentAtServerMs)
	}

	// Over-long display names are capped, not rejected (display label only).
	longName := strings.Repeat("n", maxChatNameLen+10)
	payload, _ := json.Marshal(map[string]string{"roomId": "v", "text": "hi", "name": longName})
	res, err = h.HandleRPC("chat.send", payload, "")
	if err != nil {
		t.Fatalf("long-name send: %v", err)
	}
	if err := json.Unmarshal(res, &out); err != nil {
		t.Fatalf("unmarshal long-name result: %v", err)
	}
	if len(out.Message.Name) != maxChatNameLen {
		t.Fatalf("name must cap at %d chars, got %d", maxChatNameLen, len(out.Message.Name))
	}
}

// TestChatHistory_OldestFirstCapsAt50 sends 60 messages and expects the last
// 50 back, oldest first.
func TestChatHistory_OldestFirstCapsAt50(t *testing.T) {
	h := newChatTestHub(t)

	for i := 0; i < 60; i++ {
		payload := fmt.Sprintf(`{"roomId":"h","text":"msg %02d","name":"a"}`, i)
		if _, err := h.HandleRPC("chat.send", []byte(payload), ""); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}

	res, err := h.HandleRPC("chat.history", []byte(`{"roomId":"h"}`), "")
	if err != nil {
		t.Fatalf("chat.history: %v", err)
	}
	var out struct {
		Messages []ChatMessage `json:"messages"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		t.Fatalf("unmarshal history: %v", err)
	}
	if len(out.Messages) != maxChatHistory {
		t.Fatalf("history len = %d, want %d (ring cap)", len(out.Messages), maxChatHistory)
	}
	if out.Messages[0].Text != "msg 10" {
		t.Fatalf("oldest retained = %q, want %q (first 10 dropped)", out.Messages[0].Text, "msg 10")
	}
	if out.Messages[len(out.Messages)-1].Text != "msg 59" {
		t.Fatalf("newest = %q, want %q", out.Messages[len(out.Messages)-1].Text, "msg 59")
	}
}

// TestChatHistory_EmptyRoomReturnsEmptyList pins the wire shape for a room
// with no chat yet: an empty array, never null.
func TestChatHistory_EmptyRoomReturnsEmptyList(t *testing.T) {
	h := newChatTestHub(t)

	res, err := h.HandleRPC("chat.history", []byte(`{"roomId":"fresh"}`), "")
	if err != nil {
		t.Fatalf("chat.history: %v", err)
	}
	var out struct {
		Messages []ChatMessage `json:"messages"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		t.Fatalf("unmarshal history: %v", err)
	}
	if out.Messages == nil {
		t.Fatal("empty history must marshal as [], not null")
	}
	if len(out.Messages) != 0 {
		t.Fatalf("fresh room history len = %d, want 0", len(out.Messages))
	}
}

// TestChat_VersionDiscipline is the inverse of the RoomState Version rule
// (AGENTS.md gotcha #2): chat is NOT room state, so sends must not bump
// Version and the state payload must not carry chat content. Guards against
// someone later "simplifying" chat into RoomState and reintroducing
// per-message full-state fan-out.
func TestChat_VersionDiscipline(t *testing.T) {
	h := newChatTestHub(t)

	joinRes, err := h.HandleRPC("room.join", []byte(`{"roomId":"vd","name":"ana"}`), "")
	if err != nil {
		t.Fatalf("room.join: %v", err)
	}
	var before queue.RoomState
	if err := json.Unmarshal(joinRes, &before); err != nil {
		t.Fatalf("unmarshal join: %v", err)
	}

	for i := 0; i < 3; i++ {
		payload := fmt.Sprintf(`{"roomId":"vd","text":"hello %d","name":"ana"}`, i)
		if _, err := h.HandleRPC("chat.send", []byte(payload), ""); err != nil {
			t.Fatalf("chat.send %d: %v", i, err)
		}
	}

	joinRes, err = h.HandleRPC("room.join", []byte(`{"roomId":"vd","name":"ana"}`), "")
	if err != nil {
		t.Fatalf("room.join after chat: %v", err)
	}
	var after queue.RoomState
	if err := json.Unmarshal(joinRes, &after); err != nil {
		t.Fatalf("unmarshal rejoin: %v", err)
	}
	if after.Version != before.Version {
		t.Fatalf("chat.send bumped RoomState.Version: before %d, after %d", before.Version, after.Version)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(joinRes, &raw); err != nil {
		t.Fatalf("unmarshal raw state: %v", err)
	}
	if _, ok := raw["chat"]; ok {
		t.Fatal("RoomState payload carries chat content; chat must stay out of RoomState")
	}
}

// TestChat_NeverPersists pins the ephemeral guarantee: chat.send performs no
// store.Save (the only save below is GetOrCreateRoom persisting the fresh room
// on join).
func TestChat_NeverPersists(t *testing.T) {
	st := &saveCountingStore{inner: store.NewMemory()}
	h := NewHub(nil).WithStore(st).WithChat(true)
	h.chatLimiter = nil

	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"np","name":"ana"}`), ""); err != nil {
		t.Fatalf("room.join: %v", err)
	}
	savesAfterJoin := st.saveCount()

	for i := 0; i < 3; i++ {
		payload := fmt.Sprintf(`{"roomId":"np","text":"hello %d","name":"ana"}`, i)
		if _, err := h.HandleRPC("chat.send", []byte(payload), ""); err != nil {
			t.Fatalf("chat.send %d: %v", i, err)
		}
	}
	if _, err := h.HandleRPC("chat.history", []byte(`{"roomId":"np"}`), ""); err != nil {
		t.Fatalf("chat.history: %v", err)
	}

	if got := st.saveCount(); got != savesAfterJoin {
		t.Fatalf("chat wrote to the store: %d saves after join, want %d", got, savesAfterJoin)
	}
}

// TestChatSend_RateLimited shrinks the chat limiter and expects the burst to
// be enforced per caller, with the same client-visible message as fanout
// rejections. chat.history stays unlimited (bounded read, once per join).
func TestChatSend_RateLimited(t *testing.T) {
	h := NewHub(nil).WithChat(true)
	clock := &fakeClock{now: time.Now()}
	h.chatLimiter = newRateLimiter(2, time.Hour, clock.Now) // no refill during the test

	send := []byte(`{"roomId":"rl","text":"hi","name":"a"}`)
	for i := 0; i < 2; i++ {
		if _, err := h.HandleRPC("chat.send", send, "u1"); err != nil {
			t.Fatalf("send %d within burst: %v", i+1, err)
		}
	}

	_, err := h.HandleRPC("chat.send", send, "u1")
	var ue *UserError
	if !errors.As(err, &ue) {
		t.Fatalf("burst+1 send: got %v (%T), want a *UserError", err, err)
	}
	if ue.Error() != "too many requests, slow down" {
		t.Fatalf("rejection message = %q, want %q", ue.Error(), "too many requests, slow down")
	}

	// chat.history does not draw from the chat bucket.
	if _, err := h.HandleRPC("chat.history", []byte(`{"roomId":"rl"}`), "u1"); err != nil {
		t.Fatalf("chat.history must not be rate-limited: %v", err)
	}

	// A different caller has its own bucket.
	if _, err := h.HandleRPC("chat.send", send, "u2"); err != nil {
		t.Fatalf("u2 first send must succeed: %v", err)
	}
}

// TestChat_DisabledReturnsMethodNotFound pins the dark-ship default: without
// WithChat(true) both chat RPCs behave like transport.* with FEATURE_SYNC off.
func TestChat_DisabledReturnsMethodNotFound(t *testing.T) {
	h := NewHub(nil)

	if _, err := h.HandleRPC("chat.send", []byte(`{"roomId":"x","text":"hi","name":"a"}`), ""); !errors.Is(err, centrifuge.ErrorMethodNotFound) {
		t.Fatalf("chat.send with flag off: got %v, want ErrorMethodNotFound", err)
	}
	if _, err := h.HandleRPC("chat.history", []byte(`{"roomId":"x"}`), ""); !errors.Is(err, centrifuge.ErrorMethodNotFound) {
		t.Fatalf("chat.history with flag off: got %v, want ErrorMethodNotFound", err)
	}
}
