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

// newPublicHub returns a hub with the public rooms feature on, as wired by
// cmd/server/main.go behind FEATURE_PUBLIC_ROOMS.
func newPublicHub() *Hub {
	return NewHub(nil).WithPublicRooms(true)
}

func setPublicPayload(roomID string, public bool) []byte {
	return []byte(fmt.Sprintf(`{"roomId":%q,"public":%t}`, roomID, public))
}

func listRooms(t *testing.T, h *Hub, userID string) []PublicRoomSummary {
	t.Helper()
	res, err := h.HandleRPC("room.list", []byte(`{}`), userID)
	if err != nil {
		t.Fatalf("room.list: %v", err)
	}
	var out struct {
		Rooms []PublicRoomSummary `json:"rooms"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		t.Fatalf("unmarshal room.list result: %v", err)
	}
	return out.Rooms
}

// room.set_public changes room state, so a non-member caller is rejected at
// the transport boundary (mutatingMethods gate).
func TestSetPublic_NonMemberRejected(t *testing.T) {
	h := newPublicHub()

	if err := h.Authorize(newTestClient("attacker", ""), "room.set_public", setPublicPayload("x", true)); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("unjoined room.set_public: got %v, want ErrorPermissionDenied", err)
	}

	h.Join("member", "x")
	if err := h.Authorize(newTestClient("member", ""), "room.set_public", setPublicPayload("x", true)); err != nil {
		t.Fatalf("member room.set_public: got %v, want nil", err)
	}
}

// Directory membership is a room-control decision (same class as radio.set):
// with a host assigned, a non-host member is rejected and the host is allowed.
func TestSetPublic_HostOnly(t *testing.T) {
	h := newPublicHub()

	// alice becomes host of room1 (first authenticated joiner).
	h.RecordClientUserID("alice_client", "alice")
	h.Join("alice_client", "room1")
	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"room1","name":"alice"}`), "alice"); err != nil {
		t.Fatalf("room.join: %v", err)
	}

	// bob is a member but not the host.
	h.RecordClientUserID("bob_client", "bob")
	h.Join("bob_client", "room1")

	if err := h.Authorize(newTestClient("bob_client", "bob"), "room.set_public", setPublicPayload("room1", true)); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("non-host room.set_public: got %v, want ErrorPermissionDenied", err)
	}
	if err := h.Authorize(newTestClient("alice_client", "alice"), "room.set_public", setPublicPayload("room1", true)); err != nil {
		t.Fatalf("host room.set_public: got %v, want nil", err)
	}
}

// AGENTS.md gotcha #2 regression: a published mutation that forgets Version++
// is silently dropped by version-guarded clients. room.set_public must bump.
func TestSetPublic_BumpsVersion(t *testing.T) {
	h := newPublicHub()

	joinRes, err := h.HandleRPC("room.join", []byte(`{"roomId":"v1","name":"alice"}`), "")
	if err != nil {
		t.Fatalf("room.join: %v", err)
	}
	var before queue.RoomState
	if err := json.Unmarshal(joinRes, &before); err != nil {
		t.Fatalf("unmarshal join result: %v", err)
	}

	res, err := h.HandleRPC("room.set_public", setPublicPayload("v1", true), "")
	if err != nil {
		t.Fatalf("room.set_public: %v", err)
	}
	var after queue.RoomState
	if err := json.Unmarshal(res, &after); err != nil {
		t.Fatalf("unmarshal set_public result: %v", err)
	}

	if after.Version != before.Version+1 {
		t.Fatalf("version = %d, want %d (before %d + 1)", after.Version, before.Version+1, before.Version)
	}
	if !after.Public {
		t.Fatal("public flag not set in returned state")
	}
}

// Privacy default: a fresh room is private (zero value) and absent from
// room.list. Opting in lists it with memberCount + nowPlaying; opting back out
// unlists it.
func TestRoomList_PrivacyDefaultAndToggle(t *testing.T) {
	h := newPublicHub()

	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"pub1","name":"alice"}`), ""); err != nil {
		t.Fatalf("room.join: %v", err)
	}

	// Fresh room: private, so absent from the directory.
	for _, r := range listRooms(t, h, "anon") {
		if r.RoomID == "pub1" {
			t.Fatal("fresh private room must not appear in room.list")
		}
	}

	// Opt in with a label, queue a track, connect two members.
	if _, err := h.HandleRPC("room.set_public", []byte(`{"roomId":"pub1","public":true,"name":"Neon"}`), ""); err != nil {
		t.Fatalf("room.set_public: %v", err)
	}
	add := []byte(`{"roomId":"pub1","track":{"title":"Instant Crush","artist":"Daft Punk","sources":{},"addedBy":"alice"}}`)
	if _, err := h.HandleRPC("queue.add", add, ""); err != nil {
		t.Fatalf("queue.add: %v", err)
	}
	h.Join("c1", "pub1")
	h.Join("c2", "pub1")

	rooms := listRooms(t, h, "anon")
	if len(rooms) != 1 {
		t.Fatalf("listed %d rooms, want 1", len(rooms))
	}
	got := rooms[0]
	if got.RoomID != "pub1" || got.Name != "Neon" {
		t.Fatalf("summary = %+v, want roomId pub1 name Neon", got)
	}
	if got.MemberCount != 2 {
		t.Fatalf("memberCount = %d, want 2", got.MemberCount)
	}
	if got.NowPlaying == nil || got.NowPlaying.Title != "Instant Crush" || got.NowPlaying.Artist != "Daft Punk" {
		t.Fatalf("nowPlaying = %+v, want Instant Crush / Daft Punk", got.NowPlaying)
	}

	// The directory view must not leak room-channel-only data.
	var raw map[string]interface{}
	res, _ := h.HandleRPC("room.list", []byte(`{}`), "anon")
	if err := json.Unmarshal(res, &raw); err != nil {
		t.Fatalf("unmarshal raw: %v", err)
	}
	entry := raw["rooms"].([]interface{})[0].(map[string]interface{})
	for _, leaked := range []string{"queue", "hostUserId", "transport", "version", "radioEnabled"} {
		if _, ok := entry[leaked]; ok {
			t.Fatalf("room.list summary leaks %q", leaked)
		}
	}

	// Opt back out: the room vanishes from the listing.
	if _, err := h.HandleRPC("room.set_public", setPublicPayload("pub1", false), ""); err != nil {
		t.Fatalf("room.set_public off: %v", err)
	}
	if rooms := listRooms(t, h, "anon"); len(rooms) != 0 {
		t.Fatalf("after opt-out listed %d rooms, want 0", len(rooms))
	}
}

// The directory is capped at 20 and sorted by memberCount descending (roomId
// ascending for stability).
func TestRoomList_CappedAndSorted(t *testing.T) {
	h := newPublicHub()

	// 25 public rooms, each with a queued track so the dead-room filter
	// (0 members AND empty queue) does not apply.
	for i := 0; i < 25; i++ {
		roomID := fmt.Sprintf("r%02d", i)
		if _, err := h.HandleRPC("room.join", []byte(fmt.Sprintf(`{"roomId":%q,"name":"alice"}`, roomID)), ""); err != nil {
			t.Fatalf("room.join %s: %v", roomID, err)
		}
		add := []byte(fmt.Sprintf(`{"roomId":%q,"track":{"title":"T","artist":"A","sources":{},"addedBy":"alice"}}`, roomID))
		if _, err := h.HandleRPC("queue.add", add, ""); err != nil {
			t.Fatalf("queue.add %s: %v", roomID, err)
		}
		if _, err := h.HandleRPC("room.set_public", setPublicPayload(roomID, true), ""); err != nil {
			t.Fatalf("room.set_public %s: %v", roomID, err)
		}
	}

	// Distinct member counts on the first three rooms.
	for i := 0; i < 3; i++ {
		for j := 0; j < 3-i; j++ {
			h.Join(fmt.Sprintf("m%d-%d", i, j), fmt.Sprintf("r%02d", i))
		}
	}

	rooms := listRooms(t, h, "anon")
	if len(rooms) != 20 {
		t.Fatalf("listed %d rooms, want cap of 20", len(rooms))
	}
	wantOrder := []struct {
		roomID string
		count  int
	}{{"r00", 3}, {"r01", 2}, {"r02", 1}}
	for i, want := range wantOrder {
		if rooms[i].RoomID != want.roomID || rooms[i].MemberCount != want.count {
			t.Fatalf("rooms[%d] = %+v, want %s with %d members", i, rooms[i], want.roomID, want.count)
		}
	}
	// The remaining entries tie at 0 members: roomId ascending fills the cap.
	for i := 3; i < 20; i++ {
		want := fmt.Sprintf("r%02d", i)
		if rooms[i].RoomID != want {
			t.Fatalf("rooms[%d] = %s, want %s (stable roomId order)", i, rooms[i].RoomID, want)
		}
	}
}

// Loaded-but-idle rooms (0 members AND an empty queue) are dead and excluded.
// A 0-member room with a queued track still lists (paused, still joinable), as
// does a room with members but nothing queued.
func TestRoomList_FiltersDeadRooms(t *testing.T) {
	h := newPublicHub()

	mkRoom := func(roomID string, withTrack bool) {
		if _, err := h.HandleRPC("room.join", []byte(fmt.Sprintf(`{"roomId":%q,"name":"alice"}`, roomID)), ""); err != nil {
			t.Fatalf("room.join %s: %v", roomID, err)
		}
		if withTrack {
			add := []byte(fmt.Sprintf(`{"roomId":%q,"track":{"title":"T","artist":"A","sources":{},"addedBy":"alice"}}`, roomID))
			if _, err := h.HandleRPC("queue.add", add, ""); err != nil {
				t.Fatalf("queue.add %s: %v", roomID, err)
			}
		}
		if _, err := h.HandleRPC("room.set_public", setPublicPayload(roomID, true), ""); err != nil {
			t.Fatalf("room.set_public %s: %v", roomID, err)
		}
	}

	mkRoom("dead", false)     // 0 members, empty queue: filtered
	mkRoom("paused", true)    // 0 members, queued track: listed
	mkRoom("listening", true) // members present: listed
	h.Join("c1", "listening")

	rooms := listRooms(t, h, "anon")
	got := map[string]bool{}
	for _, r := range rooms {
		got[r.RoomID] = true
	}
	if got["dead"] {
		t.Fatal("dead room (0 members, empty queue) must be filtered")
	}
	if !got["paused"] {
		t.Fatal("0-member room with a queued track must still list")
	}
	if !got["listening"] {
		t.Fatal("room with members must list")
	}
}

// room.list is rate-limited per caller: after the burst the caller gets the
// same client-visible UserError as fanout rejections.
func TestRoomList_RateLimited(t *testing.T) {
	h := newPublicHub()
	h.listLimiter = newRateLimiter(2, time.Hour, time.Now) // no refill during the test

	for i := 0; i < 2; i++ {
		if _, err := h.HandleRPC("room.list", []byte(`{}`), "u1"); err != nil {
			t.Fatalf("request %d within burst: %v", i+1, err)
		}
	}
	_, err := h.HandleRPC("room.list", []byte(`{}`), "u1")
	var ue *UserError
	if !errors.As(err, &ue) {
		t.Fatalf("3rd room.list must be rejected with a *UserError, got %T: %v", err, err)
	}
	// A different caller has its own bucket.
	if _, err := h.HandleRPC("room.list", []byte(`{}`), "u2"); err != nil {
		t.Fatalf("u2 first room.list must succeed: %v", err)
	}
}

// Dark-shipped off: with WithPublicRooms(false) both new RPCs are absent
// (ErrorMethodNotFound, transport.* precedent).
func TestPublicRooms_FlagOff(t *testing.T) {
	h := NewHub(nil)

	if _, err := h.HandleRPC("room.list", []byte(`{}`), ""); !errors.Is(err, centrifuge.ErrorMethodNotFound) {
		t.Fatalf("room.list with flag off: got %v, want ErrorMethodNotFound", err)
	}
	if _, err := h.HandleRPC("room.set_public", setPublicPayload("x", true), ""); !errors.Is(err, centrifuge.ErrorMethodNotFound) {
		t.Fatalf("room.set_public with flag off: got %v, want ErrorMethodNotFound", err)
	}
}

// The store marshals the whole RoomState, so public/name survive a reload
// with zero store changes. Rooms saved before the feature load private.
func TestPublicRooms_PersistenceRoundTrip(t *testing.T) {
	mem := store.NewMemory()
	hub1 := NewHub(nil).WithStore(mem).WithPublicRooms(true)

	if _, err := hub1.HandleRPC("room.join", []byte(`{"roomId":"persist1","name":"alice"}`), ""); err != nil {
		t.Fatalf("room.join: %v", err)
	}
	if _, err := hub1.HandleRPC("room.set_public", []byte(`{"roomId":"persist1","public":true,"name":"Late Night"}`), ""); err != nil {
		t.Fatalf("room.set_public: %v", err)
	}

	// Fresh hub on the same store simulates a restart (hub_persist_test pattern).
	hub2 := NewHub(nil).WithStore(mem).WithPublicRooms(true)
	room := hub2.GetOrCreateRoom("persist1")
	if !room.State.Public {
		t.Fatal("public flag did not survive reload")
	}
	if room.State.Name != "Late Night" {
		t.Fatalf("name = %q, want %q", room.State.Name, "Late Night")
	}

	// A room that was never made public loads with the zero value: private.
	if _, err := hub1.HandleRPC("room.join", []byte(`{"roomId":"old1","name":"bob"}`), ""); err != nil {
		t.Fatalf("room.join old1: %v", err)
	}
	if got := hub2.GetOrCreateRoom("old1").State.Public; got {
		t.Fatal("pre-existing room must load private (zero value)")
	}
}

// The label is optional: absent leaves it untouched, present replaces it,
// empty-after-trim clears it, and over-long labels are rejected client-visibly.
func TestSetPublic_NameValidation(t *testing.T) {
	h := newPublicHub()
	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"n1","name":"alice"}`), ""); err != nil {
		t.Fatalf("room.join: %v", err)
	}

	state := func() queue.RoomState {
		res, err := h.HandleRPC("room.set_public", setPublicPayload("n1", true), "")
		if err != nil {
			t.Fatalf("room.set_public: %v", err)
		}
		var s queue.RoomState
		if err := json.Unmarshal(res, &s); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		return s
	}

	// Set a label; whitespace is trimmed.
	res, err := h.HandleRPC("room.set_public", []byte(`{"roomId":"n1","public":true,"name":"  Neon Room  "}`), "")
	if err != nil {
		t.Fatalf("set name: %v", err)
	}
	var s queue.RoomState
	if err := json.Unmarshal(res, &s); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if s.Name != "Neon Room" {
		t.Fatalf("name = %q, want trimmed %q", s.Name, "Neon Room")
	}

	// Absent name leaves the label untouched.
	if got := state().Name; got != "Neon Room" {
		t.Fatalf("absent name must leave label untouched, got %q", got)
	}

	// Empty after trim clears the label. Unmarshal into a fresh struct: the
	// empty name is omitted from the JSON (omitempty), so reusing s above
	// would keep the previous value.
	res, err = h.HandleRPC("room.set_public", []byte(`{"roomId":"n1","public":true,"name":"   "}`), "")
	if err != nil {
		t.Fatalf("clear name: %v", err)
	}
	var cleared queue.RoomState
	if err := json.Unmarshal(res, &cleared); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if cleared.Name != "" {
		t.Fatalf("empty-after-trim must clear the label, got %q", cleared.Name)
	}

	// Over the cap: rejected with a client-visible UserError.
	long := strings.Repeat("x", maxRoomNameLen+1)
	_, err = h.HandleRPC("room.set_public", []byte(fmt.Sprintf(`{"roomId":"n1","public":true,"name":%q}`, long)), "")
	var ue *UserError
	if !errors.As(err, &ue) {
		t.Fatalf("over-long name must be a *UserError, got %T: %v", err, err)
	}
}
