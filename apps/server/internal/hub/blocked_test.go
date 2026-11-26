package hub

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/centrifugal/centrifuge"
)

func isBlockedDisconnect(err error) bool {
	var d centrifuge.Disconnect
	return errors.As(err, &d) && d.Code == DisconnectUserBlocked.Code
}

// #259: a blocked identity is refused on every room, join included, with the
// terminal blocked code; other people and the empty identity are untouched,
// and unblocking lets the person back in.
func TestSetBlockedUsers_RefusesThePersonEverywhere(t *testing.T) {
	h := NewHub(nil)
	h.RecordClientUserID("c-bad", "sb:bad")
	h.RecordClientUserID("c-ok", "sb:ok")

	h.SetBlockedUsers([]string{"sb:bad", ""})

	if !h.IsUserBlocked("sb:bad") || h.IsUserBlocked("sb:ok") || h.IsUserBlocked("") {
		t.Fatal("only sb:bad is blocked; the empty identity names nobody")
	}
	if !h.IsClientBlocked("c-bad") || h.IsClientBlocked("c-ok") || h.IsClientBlocked("c-unknown") {
		t.Fatal("IsClientBlocked must follow the connection's identity")
	}
	for _, room := range []string{"ROOM1", "ROOM2"} {
		for _, method := range []string{"room.join", "chat.send", "queue.add"} {
			err := h.Authorize(newTestClient("c-bad", "sb:bad"), method, []byte(`{"roomId":"`+room+`"}`))
			if !isBlockedDisconnect(err) {
				t.Fatalf("%s in %s by a blocked person: got %v, want the blocked disconnect", method, room, err)
			}
		}
	}
	if h.IsMember("c-bad", "ROOM1") {
		t.Fatal("a refused join must not enrol")
	}
	if err := h.Authorize(newTestClient("c-ok", "sb:ok"), "room.join", []byte(`{"roomId":"ROOM1"}`)); err != nil {
		t.Fatalf("someone else joining: %v", err)
	}

	h.SetBlockedUsers(nil)
	if err := h.Authorize(newTestClient("c-bad", "sb:bad"), "room.join", []byte(`{"roomId":"ROOM1"}`)); err != nil {
		t.Fatalf("join after unblocking: %v", err)
	}
}

// #259: a report resolves its subject to the identity behind it while the
// member is still in the room or the chat line still in the ring; anything
// else resolves to "".
func TestReportSubject(t *testing.T) {
	h := NewHub(nil)
	h.RecordClientUserID("c-bad", "guest-bad")
	if err := h.Authorize(newTestClient("c-bad", "guest-bad"), "room.join", []byte(`{"roomId":"ROOM1"}`)); err != nil {
		t.Fatalf("room.join: %v", err)
	}
	res, err := h.chatSend("ROOM1", "oi", "X", "guest-bad")
	if err != nil {
		t.Fatalf("chat.send: %v", err)
	}
	var reply struct{ Message ChatMessage }
	if err := json.Unmarshal(res, &reply); err != nil || reply.Message.ID == "" {
		t.Fatalf("chat.send reply %s: %v", res, err)
	}

	for name, tc := range map[string]struct {
		room, kind, subject, want string
	}{
		"member in the room":     {"ROOM1", "member", "c-bad", "guest-bad"},
		"member of another room": {"ROOM2", "member", "c-bad", ""},
		"unknown member":         {"ROOM1", "member", "c-gone", ""},
		"message in the ring":    {"ROOM1", "message", reply.Message.ID, "guest-bad"},
		"message elsewhere":      {"ROOM2", "message", reply.Message.ID, ""},
		"unknown message":        {"ROOM1", "message", "nope", ""},
		"room report":            {"ROOM1", "room", "", ""},
		"empty subject":          {"ROOM1", "member", "", ""},
	} {
		if got := h.ReportSubject(tc.room, tc.kind, tc.subject).Sub; got != tc.want {
			t.Errorf("%s: ReportSubject = %q, want %q", name, got, tc.want)
		}
	}
	// What the server saw travels with the identity, so the operator can
	// compare it with what the reporter wrote.
	if s := h.ReportSubject("ROOM1", "message", reply.Message.ID); s.Name != "X" || s.Text != "oi" {
		t.Fatalf("message subject = %+v, want name X and text oi", s)
	}
}
