package erase

import (
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

func TestScrubRoom_ClearsOwnerAndEveryAdminEntry(t *testing.T) {
	s := &queue.RoomState{OwnerUserID: person, Admins: []string{person, other, person}}
	ch := ScrubRoom(s, Request{Sub: person})
	if !ch.RoleCleared || !ch.Changed() {
		t.Fatalf("changes = %+v", ch)
	}
	if s.OwnerUserID != "" || len(s.Admins) != 1 || s.Admins[0] != other {
		t.Fatalf("owner=%q admins=%v", s.OwnerUserID, s.Admins)
	}
	if s.Version != 1 {
		t.Fatalf("version = %d, want one bump", s.Version)
	}
}
