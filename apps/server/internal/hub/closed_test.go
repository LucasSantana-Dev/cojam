package hub

import (
	"errors"
	"testing"

	"github.com/centrifugal/centrifuge"
)

// #259: closing a room drops it from memory and the directory, removes every
// membership and refuses every room-scoped call, join included, with the
// terminal room-closed disconnect. Other rooms are untouched.
func TestSetClosedRooms_EndsTheRoomAndRefusesRejoin(t *testing.T) {
	h := newPublicHub()
	for _, room := range []string{"BAD1", "GOOD1"} {
		h.Join("c-"+room, room)
		if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"`+room+`","name":"Ana"}`), ""); err != nil {
			t.Fatalf("room.join %s: %v", room, err)
		}
		if _, err := h.HandleRPC("room.set_public", setPublicPayload(room, true), ""); err != nil {
			t.Fatalf("room.set_public %s: %v", room, err)
		}
	}
	if got := len(listRooms(t, h, "")); got != 2 {
		t.Fatalf("directory before closing lists %d rooms, want 2", got)
	}

	h.SetClosedRooms([]string{"BAD1", "not a room id"})

	if !h.IsRoomClosed("BAD1") || h.IsRoomClosed("GOOD1") {
		t.Fatal("only BAD1 is closed")
	}
	if h.IsMember("c-BAD1", "BAD1") {
		t.Fatal("members of a closed room must lose their membership")
	}
	if !h.IsMember("c-GOOD1", "GOOD1") {
		t.Fatal("other rooms keep their members")
	}
	h.mu.RLock()
	_, resident := h.rooms["BAD1"]
	h.mu.RUnlock()
	if resident {
		t.Fatal("a closed room must leave memory")
	}
	rooms := listRooms(t, h, "")
	if len(rooms) != 1 || rooms[0].RoomID != "GOOD1" {
		t.Fatalf("directory after closing = %+v, want only GOOD1", rooms)
	}

	for _, method := range []string{"room.join", "chat.send", "queue.add"} {
		err := h.Authorize(newTestClient("c-new", ""), method, []byte(`{"roomId":"BAD1"}`))
		var d centrifuge.Disconnect
		if !errors.As(err, &d) || d.Code != DisconnectRoomClosed.Code {
			t.Fatalf("%s on a closed room: got %v, want the room-closed disconnect", method, err)
		}
	}
	if h.IsMember("c-new", "BAD1") {
		t.Fatal("a refused join must not enrol")
	}

	// A room reloaded by a stray path still stays out of the directory.
	if _, err := h.GetOrCreateRoom("BAD1"); err != nil {
		t.Fatalf("GetOrCreateRoom: %v", err)
	}
	if got := len(listRooms(t, h, "")); got != 1 {
		t.Fatalf("directory lists %d rooms with a reloaded closed room, want 1", got)
	}
}

// Reopening is the next full list without the room: joins are accepted again.
// Re-applying the same list does not end the room a second time.
func TestSetClosedRooms_ReopenAndIdempotent(t *testing.T) {
	h := NewHub(nil)
	h.SetClosedRooms([]string{"ROOM1"})
	if err := h.Authorize(newTestClient("c1", ""), "room.join", []byte(`{"roomId":"ROOM1"}`)); err == nil {
		t.Fatal("join of a closed room must be refused")
	}

	h.SetClosedRooms(nil)
	if err := h.Authorize(newTestClient("c1", ""), "room.join", []byte(`{"roomId":"ROOM1"}`)); err != nil {
		t.Fatalf("join after reopening: %v", err)
	}
	if !h.IsMember("c1", "ROOM1") {
		t.Fatal("join after reopening must enrol")
	}

	// The room is closed again; a repeat of the same list must not touch a
	// member who joined in between (only a newly closed room is ended).
	h.SetClosedRooms([]string{"ROOM1"})
	if h.IsMember("c1", "ROOM1") {
		t.Fatal("closing again ends the room")
	}
	h.Join("c2", "ROOM1") // a direct enrolment, bypassing the gates
	h.SetClosedRooms([]string{"ROOM1"})
	if !h.IsMember("c2", "ROOM1") {
		t.Fatal("re-applying an unchanged list must not end the room again")
	}
}
