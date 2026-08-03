package hub

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

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

// TestChatSend_MultiByteTruncation pins rune-count semantics for the length
// caps (#185): a multi-byte display name truncates to maxChatNameLen runes
// without splitting a rune, and text length is counted in runes like
// maxRoomNameLen — not bytes, which would reject/slice mid-rune.
func TestChatSend_MultiByteTruncation(t *testing.T) {
	h := newChatTestHub(t)

	// 70 CJK runes (> maxChatNameLen runes, > 3x that in bytes).
	longName := strings.Repeat("名", maxChatNameLen+10) + "🎧"
	payload, _ := json.Marshal(map[string]string{"roomId": "v", "text": "hi", "name": longName})
	res, err := h.HandleRPC("chat.send", payload, "")
	if err != nil {
		t.Fatalf("multi-byte long-name send: %v", err)
	}
	var out struct {
		Message ChatMessage `json:"message"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if got := utf8.RuneCountInString(out.Message.Name); got != maxChatNameLen {
		t.Fatalf("name must cap at %d runes, got %d (%q)", maxChatNameLen, got, out.Message.Name)
	}
	if !utf8.ValidString(out.Message.Name) {
		t.Fatalf("truncated name must stay valid UTF-8: %q", out.Message.Name)
	}

	// 300 emoji are 300 runes but 1200 bytes: must be accepted (rune count).
	emojiText := strings.Repeat("🎵", maxChatTextLen)
	payload, _ = json.Marshal(map[string]string{"roomId": "v", "text": emojiText, "name": "a"})
	if _, err := h.HandleRPC("chat.send", payload, ""); err != nil {
		t.Fatalf("300-rune multi-byte text must be accepted: %v", err)
	}

	// 301 runes of CJK must still be rejected.
	payload, _ = json.Marshal(map[string]string{"roomId": "v", "text": strings.Repeat("曲", maxChatTextLen+1), "name": "a"})
	if _, err := h.HandleRPC("chat.send", payload, ""); err == nil {
		t.Fatal("301-rune text must be rejected")
	} else {
		var ue *UserError
		if !errors.As(err, &ue) {
			t.Fatalf("over-long text: got %v (%T), want a *UserError", err, err)
		}
	}
}

// chatHistoryTexts fetches the ring and flattens it to (kind, text) pairs for
// compact assertions on system-event content.
func chatHistoryKindsTexts(t *testing.T, h *Hub, roomID string) []ChatMessage {
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

// TestChatSystem_AdvanceAnnouncesOnce pins the #205 acceptance criterion: a
// real advance appends exactly one kind=system message naming the new track,
// the announcement itself bumps no RoomState.Version and performs no
// store.Save beyond the advance's own write-through, and the idempotent
// re-advance adds nothing.
func TestChatSystem_AdvanceAnnouncesOnce(t *testing.T) {
	st := &saveCountingStore{inner: store.NewMemory()}
	h := NewHub(nil).WithStore(st).WithChat(true)
	h.chatLimiter = nil

	joinRes, err := h.HandleRPC("room.join", []byte(`{"roomId":"sys","name":"ana"}`), "")
	if err != nil {
		t.Fatalf("room.join: %v", err)
	}
	var joined queue.RoomState
	if err := json.Unmarshal(joinRes, &joined); err != nil {
		t.Fatalf("unmarshal join: %v", err)
	}

	add := func(title, artist string) string {
		t.Helper()
		payload := fmt.Sprintf(`{"roomId":"sys","track":{"title":%q,"artist":%q,"sources":{},"addedBy":"ana"}}`, title, artist)
		res, err := h.HandleRPC("queue.add", []byte(payload), "")
		if err != nil {
			t.Fatalf("queue.add %s: %v", title, err)
		}
		var s queue.RoomState
		if err := json.Unmarshal(res, &s); err != nil {
			t.Fatalf("unmarshal add: %v", err)
		}
		return s.Queue[len(s.Queue)-1].ID
	}
	firstID := add("Song One", "A")
	add("Song Two", "B")

	savesBefore := st.saveCount()
	advRes, err := h.HandleRPC("now_playing.advance",
		[]byte(fmt.Sprintf(`{"roomId":"sys","afterId":%q}`, firstID)), "")
	if err != nil {
		t.Fatalf("now_playing.advance: %v", err)
	}
	var advanced queue.RoomState
	if err := json.Unmarshal(advRes, &advanced); err != nil {
		t.Fatalf("unmarshal advance: %v", err)
	}

	// Exactly one save from the advance's own write-through; the system
	// message added none.
	if got := st.saveCount(); got != savesBefore+1 {
		t.Fatalf("advance saves = %d, want %d (advance only, system message must not save)", got, savesBefore+1)
	}

	msgs := chatHistoryKindsTexts(t, h, "sys")
	if len(msgs) != 1 {
		t.Fatalf("history len = %d, want exactly 1 system message: %+v", len(msgs), msgs)
	}
	m := msgs[0]
	if m.Kind != ChatKindSystem {
		t.Fatalf("kind = %q, want %q", m.Kind, ChatKindSystem)
	}
	if m.Text != "Now playing: Song Two — B" {
		t.Fatalf("text = %q, want %q", m.Text, "Now playing: Song Two — B")
	}
	if m.Name != "" || m.UserID != "" {
		t.Fatalf("system message must carry no member identity: name=%q userId=%q", m.Name, m.UserID)
	}

	// The announcement bumps no Version: a rejoin returns the same version the
	// advance produced.
	rejoinRes, err := h.HandleRPC("room.join", []byte(`{"roomId":"sys","name":"ana"}`), "")
	if err != nil {
		t.Fatalf("rejoin: %v", err)
	}
	var rejoined queue.RoomState
	if err := json.Unmarshal(rejoinRes, &rejoined); err != nil {
		t.Fatalf("unmarshal rejoin: %v", err)
	}
	if rejoined.Version != advanced.Version {
		t.Fatalf("system message bumped Version: advance %d, after %d", advanced.Version, rejoined.Version)
	}

	// Idempotent re-advance (stale afterId) is a no-op: no second message, no
	// further save.
	if _, err := h.HandleRPC("now_playing.advance",
		[]byte(fmt.Sprintf(`{"roomId":"sys","afterId":%q}`, firstID)), ""); err != nil {
		t.Fatalf("idempotent advance: %v", err)
	}
	if got := st.saveCount(); got != savesBefore+1 {
		t.Fatalf("idempotent advance saved: saves = %d, want %d", got, savesBefore+1)
	}
	if msgs := chatHistoryKindsTexts(t, h, "sys"); len(msgs) != 1 {
		t.Fatalf("idempotent advance added a message: history len = %d, want 1", len(msgs))
	}
}

// TestChatSystem_JoinLeaveAnnounces pins membership announcements (#205): a
// new enrollment says "joined" once (re-join while still enrolled is silent),
// disconnect says "left", and the name is the server-recorded connect-time
// display name, never client params.
func TestChatSystem_JoinLeaveAnnounces(t *testing.T) {
	h := newChatTestHub(t)

	// Create the room via the RPC path (HandleRPC is transport-independent and
	// does not enroll, so no announcement fires for the creator here).
	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"jl","name":"host"}`), ""); err != nil {
		t.Fatalf("room.join: %v", err)
	}

	h.RecordClientName("c-bia", "Bia")
	h.Join("c-bia", "jl")
	h.Join("c-bia", "jl") // already enrolled: must stay silent

	h.Join("c-anon", "jl") // no connect-time name recorded

	h.Leave("c-bia")
	h.Leave("c-ghost") // never enrolled: must stay silent

	msgs := chatHistoryKindsTexts(t, h, "jl")
	want := []string{"Bia joined", "Someone joined", "Bia left"}
	if len(msgs) != len(want) {
		t.Fatalf("history len = %d, want %d: %+v", len(msgs), len(want), msgs)
	}
	for i, w := range want {
		if msgs[i].Kind != ChatKindSystem {
			t.Fatalf("msg %d kind = %q, want system", i, msgs[i].Kind)
		}
		if msgs[i].Text != w {
			t.Fatalf("msg %d text = %q, want %q", i, msgs[i].Text, w)
		}
	}
}

// TestChatSystem_DisabledStaysSilent pins the flag gate: with chat off,
// membership changes and advances produce no ring entries (and chat.history
// stays MethodNotFound).
func TestChatSystem_DisabledStaysSilent(t *testing.T) {
	h := NewHub(nil)

	h.RecordClientName("c1", "Ana")
	h.Join("c1", "off")
	h.Leave("c1")
	h.publishSystemChat("off", "Now playing: X — Y")

	room, err := h.GetOrCreateRoom("off")
	if err != nil {
		t.Fatalf("GetOrCreateRoom: %v", err)
	}
	room.mu.Lock()
	n := len(room.chat)
	room.mu.Unlock()
	if n != 0 {
		t.Fatalf("chat disabled but ring has %d messages", n)
	}
}
