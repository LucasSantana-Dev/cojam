package hub

import (
	"fmt"
	"testing"
)

// #197: Join/Leave must keep the inverted index (roomID -> clientIDs)
// consistent with the forward one, on joins, rejoins, and disconnects.
func TestMemberIndex_JoinLeaveConsistency(t *testing.T) {
	h := NewHub(nil)

	h.Join("c1", "r1")
	h.Join("c2", "r1")
	h.Join("c1", "r2")
	h.Join("c1", "r1") // rejoin: set semantics, no double count

	h.memberMu.RLock()
	if got := h.memberCountLocked("r1"); got != 2 {
		t.Fatalf("memberCountLocked(r1) = %d, want 2", got)
	}
	if got := h.memberCountLocked("r2"); got != 1 {
		t.Fatalf("memberCountLocked(r2) = %d, want 1", got)
	}
	if got := h.memberCountLocked("unknown"); got != 0 {
		t.Fatalf("memberCountLocked(unknown) = %d, want 0", got)
	}
	if !h.hasMembersLocked("r2") {
		t.Fatal("hasMembersLocked(r2) = false, want true")
	}
	h.memberMu.RUnlock()

	// Disconnect c1: both rooms lose it, r2's empty set is dropped.
	h.Leave("c1")

	h.memberMu.RLock()
	if got := h.memberCountLocked("r1"); got != 1 {
		t.Fatalf("after Leave(c1) memberCountLocked(r1) = %d, want 1", got)
	}
	if h.hasMembersLocked("r2") {
		t.Fatal("after Leave(c1) hasMembersLocked(r2) = true, want false")
	}
	if _, ok := h.roomMembers["r2"]; ok {
		t.Fatal("empty room set must be dropped from the index")
	}
	h.memberMu.RUnlock()

	// Leaving an unknown client is a no-op, not a panic.
	h.Leave("ghost")
}

// #197: IsUserIDInRoom resolves via the room's own member set.
func TestMemberIndex_IsUserIDInRoom(t *testing.T) {
	h := NewHub(nil)

	h.RecordClientUserID("c1", "alice")
	h.RecordClientUserID("c2", "bob")
	h.Join("c1", "r1")
	h.Join("c2", "r2")

	if !h.IsUserIDInRoom("r1", "alice") {
		t.Fatal("alice is a member of r1")
	}
	if h.IsUserIDInRoom("r1", "bob") {
		t.Fatal("bob is in r2, not r1")
	}
	if h.IsUserIDInRoom("r2", "alice") {
		t.Fatal("alice is in r1, not r2")
	}

	// After alice disconnects, her userID no longer counts as present.
	h.Leave("c1")
	if h.IsUserIDInRoom("r1", "alice") {
		t.Fatal("after Leave(c1) alice must not be present in r1")
	}
}

// #197: memberCount feeds room.list, so the index must reflect joins and
// disconnects in the directory response too.
func TestMemberIndex_RoomListCounts(t *testing.T) {
	h := newPublicHub()

	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"idx1","name":"alice"}`), ""); err != nil {
		t.Fatalf("room.join: %v", err)
	}
	if _, err := h.HandleRPC("room.set_public", setPublicPayload("idx1", true), ""); err != nil {
		t.Fatalf("room.set_public: %v", err)
	}
	add := []byte(`{"roomId":"idx1","track":{"title":"T","artist":"A","sources":{},"addedBy":"alice"}}`)
	if _, err := h.HandleRPC("queue.add", add, ""); err != nil {
		t.Fatalf("queue.add: %v", err)
	}

	count := func() int {
		t.Helper()
		rooms := listRooms(t, h, "anon")
		if len(rooms) != 1 {
			t.Fatalf("listed %d rooms, want 1", len(rooms))
		}
		return rooms[0].MemberCount
	}

	for i := 0; i < 5; i++ {
		h.Join(fmt.Sprintf("c%d", i), "idx1")
	}
	if got := count(); got != 5 {
		t.Fatalf("memberCount = %d, want 5", got)
	}
	for i := 0; i < 4; i++ {
		h.Leave(fmt.Sprintf("c%d", i))
	}
	if got := count(); got != 1 {
		t.Fatalf("after 4 disconnects memberCount = %d, want 1", got)
	}
}

// #197: room.list must stay flat in connected-client count. Before the
// inverted index, memberCountLocked scanned every client per room, so
// ns/op grew linearly across these sub-benchmarks; with the index the
// per-op cost is dominated by marshaling the single listed room.
func BenchmarkRoomList(b *testing.B) {
	for _, clients := range []int{10, 100, 1000, 10000} {
		b.Run(fmt.Sprintf("clients=%d", clients), func(b *testing.B) {
			h := NewHub(nil).WithPublicRooms(true)
			if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"bench","name":"alice"}`), ""); err != nil {
				b.Fatalf("room.join: %v", err)
			}
			if _, err := h.HandleRPC("room.set_public", setPublicPayload("bench", true), ""); err != nil {
				b.Fatalf("room.set_public: %v", err)
			}
			add := []byte(`{"roomId":"bench","track":{"title":"T","artist":"A","sources":{},"addedBy":"alice"}}`)
			if _, err := h.HandleRPC("queue.add", add, ""); err != nil {
				b.Fatalf("queue.add: %v", err)
			}
			// Most clients sit in OTHER rooms: the pre-index scan walked all
			// of them for every listed room.
			for i := 0; i < clients; i++ {
				h.Join(fmt.Sprintf("c%d", i), fmt.Sprintf("other-%d", i%50))
			}

			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := h.listPublicRooms(); err != nil {
					b.Fatalf("room.list: %v", err)
				}
			}
		})
	}
}
