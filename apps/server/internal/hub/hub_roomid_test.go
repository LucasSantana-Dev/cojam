package hub

import (
	"errors"
	"testing"
	"time"

	"github.com/centrifugal/centrifuge"
)

func TestValidRoomID(t *testing.T) {
	for _, tc := range []struct {
		id   string
		want bool
	}{
		{"0123456789AB", true}, // current generator: 12 uppercase base36
		{"ZZZZZZZZZZZZ", true},
		{"ABC123", true}, // legacy 6-char ids
		{"A", true},      // legacy generator could emit fewer than 6
		{"", false},
		{"abc123", false},
		{"ABCDEFGHIJKLM", false}, // 13 chars
		{"AB-123", false},
		{"AB_123", false},
		{"AB 123", false},
		{"room:AB", false},
		{"ÄBC123", false},
		{"ABC123\n", false},
	} {
		if got := ValidRoomID(tc.id); got != tc.want {
			t.Errorf("ValidRoomID(%q) = %v, want %v", tc.id, got, tc.want)
		}
	}
}

func TestRoomIDFromChannel(t *testing.T) {
	for _, tc := range []struct {
		channel string
		id      string
		ok      bool
	}{
		{"room:ABC123", "ABC123", true},
		{"room:0123456789AB", "0123456789AB", true},
		{"room:", "", false},
		{"room:abc", "", false},
		{"room:ABC:DEF", "", false},
		{"ABC123", "", false},
		{"chat:ABC123", "", false},
		{"$private", "", false},
		{"", "", false},
	} {
		id, ok := RoomIDFromChannel(tc.channel)
		if id != tc.id || ok != tc.ok {
			t.Errorf("RoomIDFromChannel(%q) = (%q, %v), want (%q, %v)", tc.channel, id, ok, tc.id, tc.ok)
		}
	}
}

// Every RPC carrying a roomId is rejected at the transport boundary when the
// id is malformed, before enrollment or dispatch.
func TestAuthorize_RejectsInvalidRoomID(t *testing.T) {
	h := NewHub(nil)
	c := newTestClient("c1", "")
	for _, m := range []string{"room.join", "queue.add", "chat.send", "track.lyrics"} {
		err := h.Authorize(c, m, []byte(`{"roomId":"not a room"}`))
		var ce *centrifuge.Error
		if !errors.As(err, &ce) || ce.Code != 400 {
			t.Fatalf("%s with invalid roomId: got %v, want a code-400 error", m, err)
		}
	}
	if h.IsMember("c1", "not a room") {
		t.Fatal("an invalid room id must never enrol the client")
	}
	if err := h.Authorize(c, "room.join", []byte(`{"roomId":"ABC123"}`)); err != nil {
		t.Fatalf("valid room.join: %v", err)
	}
}

// Creating rooms draws from a per-caller budget; joining a room that already
// exists does not.
func TestRoomCreationBudget_NewRoomsOnly(t *testing.T) {
	h := NewHub(nil)
	h.roomCreateLimiter = newRateLimiter(2, time.Hour, time.Now)

	for _, id := range []string{"NEWROOM1", "NEWROOM2"} {
		if _, err := h.handleRPC("room.join", []byte(`{"roomId":"`+id+`"}`), "c1", "u1"); err != nil {
			t.Fatalf("create %s within budget: %v", id, err)
		}
	}
	_, err := h.handleRPC("room.join", []byte(`{"roomId":"NEWROOM3"}`), "c1", "u1")
	var ue *UserError
	if !errors.As(err, &ue) {
		t.Fatalf("third new room: got %v, want a UserError", err)
	}
	h.mu.RLock()
	_, created := h.rooms["NEWROOM3"]
	h.mu.RUnlock()
	if created {
		t.Fatal("a rejected creation must not create the room")
	}

	// Existing rooms (another caller created one) stay joinable.
	if _, err := h.handleRPC("room.join", []byte(`{"roomId":"OTHER1"}`), "c2", "u2"); err != nil {
		t.Fatalf("other caller create: %v", err)
	}
	if _, err := h.handleRPC("room.join", []byte(`{"roomId":"OTHER1"}`), "c1", "u1"); err != nil {
		t.Fatalf("joining an existing room must not draw from the creation budget: %v", err)
	}

	// Membership-gated RPCs that would create a room draw from it too.
	h.Join("c1", "NEWROOM4")
	if _, err := h.handleRPC("queue.add", []byte(`{"roomId":"NEWROOM4","track":{"title":"t","artist":"a","sources":{}}}`), "c1", "u1"); !errors.As(err, &ue) {
		t.Fatalf("queue.add creating a room past the budget: got %v, want a UserError", err)
	}
}

func TestRoomJoin_RateLimited(t *testing.T) {
	h := NewHub(nil)
	h.joinLimiter = newRateLimiter(2, time.Hour, time.Now)
	join := []byte(`{"roomId":"JOINRL1"}`)
	for i := 0; i < 2; i++ {
		if _, err := h.handleRPC("room.join", join, "c1", "u1"); err != nil {
			t.Fatalf("join %d within burst: %v", i+1, err)
		}
	}
	_, err := h.handleRPC("room.join", join, "c1", "u1")
	var ue *UserError
	if !errors.As(err, &ue) {
		t.Fatalf("join past burst: got %v, want a UserError", err)
	}
	// Another caller has its own bucket.
	if _, err := h.handleRPC("room.join", join, "c2", "u2"); err != nil {
		t.Fatalf("other caller join: %v", err)
	}
}
