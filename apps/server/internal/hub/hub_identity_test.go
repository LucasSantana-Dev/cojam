package hub

import (
	"encoding/json"
	"testing"
)

// #165 (parent #141): presence/membership is keyed on the connection identity
// (clientID/userID), never on the display name — two connections that picked
// the same name are two distinct members and count as two listeners.
func TestPresence_SameNameConnections_AreDistinctMembers(t *testing.T) {
	h := NewHub(nil).WithPublicRooms(true)

	h.RecordClientName("c1", "alice")
	h.RecordClientName("c2", "alice")
	h.Join("c1", "dup")
	h.Join("c2", "dup")

	if !h.IsMember("c1", "dup") || !h.IsMember("c2", "dup") {
		t.Fatalf("both same-name connections must be members of dup")
	}

	// The directory's memberCount is the server-side listener count: two
	// same-name connections must count as 2, not collapse to 1.
	if _, err := h.handleRPC("room.set_public", []byte(`{"roomId":"dup","public":true}`), "c1", ""); err != nil {
		t.Fatalf("set_public: %v", err)
	}
	res, err := h.handleRPC("room.list", []byte(`{}`), "c1", "")
	if err != nil {
		t.Fatalf("room.list: %v", err)
	}
	var listing struct {
		Rooms []struct {
			RoomID      string `json:"roomId"`
			MemberCount int    `json:"memberCount"`
		} `json:"rooms"`
	}
	if err := json.Unmarshal(res, &listing); err != nil {
		t.Fatalf("unmarshal room.list: %v", err)
	}
	if len(listing.Rooms) != 1 || listing.Rooms[0].MemberCount != 2 {
		t.Fatalf("listener count for two same-name connections: got %+v, want one room with memberCount 2", listing.Rooms)
	}

	// Disconnecting one leaves the other's entry untouched.
	h.Leave("c1")
	h.RemoveClientUserID("c1")
	if !h.IsMember("c2", "dup") {
		t.Fatalf("c2 membership must survive c1 disconnect")
	}
	if name := h.displayName("c1"); name != "" {
		t.Fatalf("c1 display name must be dropped on disconnect, got %q", name)
	}
	if name := h.displayName("c2"); name != "alice" {
		t.Fatalf("c2 display name must survive c1 disconnect, got %q", name)
	}
}

// #165 regression: a crafted queue.add that spoofs another member's addedBy
// cannot change displayed attribution — the server stamps the display name
// the connection presented at connect time. The mutation still bumps Version.
func TestQueueAdd_SpoofedAddedBy_IsOverridden(t *testing.T) {
	h := NewHub(nil)
	h.RecordClientName("c_bob", "bob")
	h.Join("c_bob", "spoof")

	res, err := h.handleRPC("queue.add",
		[]byte(`{"roomId":"spoof","track":{"title":"T","artist":"A","sources":{},"addedBy":"alice"}}`),
		"c_bob", "uid_bob")
	if err != nil {
		t.Fatalf("queue.add: %v", err)
	}
	var state struct {
		Version int64 `json:"version"`
		Queue   []struct {
			AddedBy       string `json:"addedBy"`
			AddedByUserID string `json:"addedByUserId"`
		} `json:"queue"`
	}
	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("unmarshal queue.add: %v", err)
	}
	if len(state.Queue) != 1 {
		t.Fatalf("queue length: got %d, want 1", len(state.Queue))
	}
	if state.Queue[0].AddedBy != "bob" {
		t.Fatalf("spoofed addedBy must be overridden: got %q, want %q", state.Queue[0].AddedBy, "bob")
	}
	if state.Queue[0].AddedByUserID != "uid_bob" {
		t.Fatalf("addedByUserId must be server-stamped: got %q, want %q", state.Queue[0].AddedByUserID, "uid_bob")
	}
	if state.Version != 1 {
		t.Fatalf("version after queue.add: got %d, want 1 (bump on every mutation)", state.Version)
	}
}

// playlist.import shares the trust boundary: its addedBy param is overridden
// by the connection identity the same way.
func TestPlaylistImport_SpoofedAddedBy_IsOverridden(t *testing.T) {
	h := NewHub(nil)
	h.RecordClientName("c_bob", "bob")
	h.Join("c_bob", "imp")

	res, err := h.handleRPC("playlist.import",
		[]byte(`{"roomId":"imp","url":"https://example.com/pl","addedBy":"alice","tracks":[{"title":"S1","artist":"B","sources":{}},{"title":"S2","artist":"B","sources":{}}]}`),
		"c_bob", "uid_bob")
	if err != nil {
		t.Fatalf("playlist.import: %v", err)
	}
	var state struct {
		Queue []struct {
			AddedBy       string `json:"addedBy"`
			AddedByUserID string `json:"addedByUserId"`
		} `json:"queue"`
	}
	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("unmarshal playlist.import: %v", err)
	}
	if len(state.Queue) != 2 {
		t.Fatalf("queue length: got %d, want 2", len(state.Queue))
	}
	for i, tr := range state.Queue {
		if tr.AddedBy != "bob" {
			t.Fatalf("track %d: spoofed addedBy must be overridden: got %q, want %q", i, tr.AddedBy, "bob")
		}
		if tr.AddedByUserID != "uid_bob" {
			t.Fatalf("track %d: addedByUserId must be server-stamped: got %q, want %q", i, tr.AddedByUserID, "uid_bob")
		}
	}
}

// When the server has no recorded display name for the caller (room auth off
// and no connect-data name, or transport-independent callers), the validated
// client-supplied addedBy stands — v0 behavior is unchanged.
func TestQueueAdd_NoRecordedName_KeepsClientValue(t *testing.T) {
	h := NewHub(nil)

	res, err := h.HandleRPC("queue.add",
		[]byte(`{"roomId":"v0","track":{"title":"T","artist":"A","sources":{},"addedBy":"alice"}}`), "")
	if err != nil {
		t.Fatalf("queue.add: %v", err)
	}
	var state struct {
		Queue []struct {
			AddedBy string `json:"addedBy"`
		} `json:"queue"`
	}
	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("unmarshal queue.add: %v", err)
	}
	if len(state.Queue) != 1 || state.Queue[0].AddedBy != "alice" {
		t.Fatalf("client addedBy must stand without a recorded name: got %+v", state.Queue)
	}
}
