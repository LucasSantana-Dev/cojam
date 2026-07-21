package hub

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/centrifugal/centrifuge"
)

// srJoin enrolls clientID as userID in roomID and performs room.join.
func srJoin(t *testing.T, h *Hub, clientID, userID, roomID string) {
	t.Helper()
	h.RecordClientUserID(clientID, userID)
	h.Join(clientID, roomID)
	join := fmt.Sprintf(`{"roomId":%q,"name":%q}`, roomID, userID)
	if _, err := h.HandleRPC("room.join", []byte(join), userID); err != nil {
		t.Fatalf("room.join %s: %v", userID, err)
	}
}

type srState struct {
	Queue []struct {
		ID            string `json:"id"`
		AddedByUserID string `json:"addedByUserId"`
	} `json:"queue"`
	Version int64 `json:"version"`
}

// srAdd queues a track as userID (extraTrackJSON injects raw track fields) and
// returns the parsed room state after the add.
func srAdd(t *testing.T, h *Hub, roomID, userID, extraTrackJSON string) srState {
	t.Helper()
	payload := fmt.Sprintf(`{"roomId":%q,"track":{"title":"Song","artist":"A","sources":{},"addedBy":%q%s}}`,
		roomID, userID, extraTrackJSON)
	res, err := h.HandleRPC("queue.add", []byte(payload), userID)
	if err != nil {
		t.Fatalf("queue.add %s: %v", userID, err)
	}
	var st srState
	if err := json.Unmarshal(res, &st); err != nil {
		t.Fatalf("unmarshal add result: %v", err)
	}
	if len(st.Queue) == 0 {
		t.Fatal("queue.add result has empty queue")
	}
	return st
}

func srRemoveRPC(trackID, roomID string) []byte {
	return []byte(fmt.Sprintf(`{"roomId":%q,"trackId":%q}`, roomID, trackID))
}

// B16 (RFC-0005): with room auth on, a listener may remove a track they added.
func TestSelfRemove_ListenerRemovesOwnTrack(t *testing.T) {
	h := NewHub(nil)
	srJoin(t, h, "alice_client", "alice", "sr1") // host
	srJoin(t, h, "bob_client", "bob", "sr1")     // listener

	added := srAdd(t, h, "sr1", "bob", "")
	trackID := added.Queue[len(added.Queue)-1].ID
	if got := added.Queue[len(added.Queue)-1].AddedByUserID; got != "bob" {
		t.Fatalf("addedByUserId should be stamped from the connection identity: got %q, want bob", got)
	}

	bob := newTestClient("bob_client", "bob")
	if err := h.Authorize(bob, "queue.remove", srRemoveRPC(trackID, "sr1")); err != nil {
		t.Fatalf("owner bob queue.remove: got %v, want nil", err)
	}

	res, err := h.HandleRPC("queue.remove", srRemoveRPC(trackID, "sr1"), "bob")
	if err != nil {
		t.Fatalf("owner remove dispatch: %v", err)
	}
	var st srState
	if err := json.Unmarshal(res, &st); err != nil {
		t.Fatalf("unmarshal remove result: %v", err)
	}
	if len(st.Queue) != 0 {
		t.Fatalf("track should be gone: queue len %d", len(st.Queue))
	}
	if st.Version <= added.Version {
		t.Fatalf("Version must bump on remove: before %d, after %d", added.Version, st.Version)
	}
}

// B16: a different listener cannot remove someone else's track.
func TestSelfRemove_OtherListenerDenied(t *testing.T) {
	h := NewHub(nil)
	srJoin(t, h, "alice_client", "alice", "sr2")
	srJoin(t, h, "bob_client", "bob", "sr2")
	srJoin(t, h, "carol_client", "carol", "sr2")

	added := srAdd(t, h, "sr2", "bob", "")
	trackID := added.Queue[len(added.Queue)-1].ID

	carol := newTestClient("carol_client", "carol")
	if err := h.Authorize(carol, "queue.remove", srRemoveRPC(trackID, "sr2")); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("carol removing bob's track: got %v, want ErrorPermissionDenied", err)
	}

	// State unchanged: the track is still queued.
	room := h.GetOrCreateRoom("sr2")
	room.mu.Lock()
	defer room.mu.Unlock()
	if len(room.State.Queue) != 1 || room.State.Queue[0].ID != trackID {
		t.Fatalf("state must be unchanged after denied remove: %+v", room.State.Queue)
	}
	if room.State.Version != added.Version {
		t.Fatalf("Version must not bump on denied remove: before %d, after %d", added.Version, room.State.Version)
	}
}

// B16: the host can still remove anyone's track.
func TestSelfRemove_HostRemovesAnyonesTrack(t *testing.T) {
	h := NewHub(nil)
	srJoin(t, h, "alice_client", "alice", "sr3")
	srJoin(t, h, "bob_client", "bob", "sr3")

	added := srAdd(t, h, "sr3", "bob", "")
	trackID := added.Queue[len(added.Queue)-1].ID

	alice := newTestClient("alice_client", "alice")
	if err := h.Authorize(alice, "queue.remove", srRemoveRPC(trackID, "sr3")); err != nil {
		t.Fatalf("host alice queue.remove: got %v, want nil", err)
	}
	if _, err := h.HandleRPC("queue.remove", srRemoveRPC(trackID, "sr3"), "alice"); err != nil {
		t.Fatalf("host remove dispatch: %v", err)
	}
}

// B16: a client-supplied addedByUserId is never trusted; the server stamps the
// connection identity.
func TestSelfRemove_ClientSuppliedAddedByUserIdOverwritten(t *testing.T) {
	h := NewHub(nil)
	srJoin(t, h, "alice_client", "alice", "sr4")
	srJoin(t, h, "bob_client", "bob", "sr4")

	added := srAdd(t, h, "sr4", "bob", `,"addedByUserId":"mallory"`)
	if got := added.Queue[len(added.Queue)-1].AddedByUserID; got != "bob" {
		t.Fatalf("client-supplied addedByUserId must be overwritten: got %q, want bob", got)
	}

	// And the spoofed identity grants nothing: "mallory" cannot remove it.
	mallory := newTestClient("mallory_client", "mallory")
	h.Join("mallory_client", "sr4")
	trackID := added.Queue[len(added.Queue)-1].ID
	if err := h.Authorize(mallory, "queue.remove", srRemoveRPC(trackID, "sr4")); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("spoofed owner remove: got %v, want ErrorPermissionDenied", err)
	}
}

// B16 flag-off: with room auth off (no userIDs, no host), any member can still
// remove any track, exactly as before.
func TestSelfRemove_FlagOffEqualMember(t *testing.T) {
	h := NewHub(nil)
	srJoin(t, h, "anon1_client", "", "sr5")
	srJoin(t, h, "anon2_client", "", "sr5")

	added := srAdd(t, h, "sr5", "", "")
	trackID := added.Queue[len(added.Queue)-1].ID
	if got := added.Queue[len(added.Queue)-1].AddedByUserID; got != "" {
		t.Fatalf("anonymous add must carry no addedByUserId: got %q", got)
	}

	anon2 := newTestClient("anon2_client", "")
	if err := h.Authorize(anon2, "queue.remove", srRemoveRPC(trackID, "sr5")); err != nil {
		t.Fatalf("flag-off member remove: got %v, want nil", err)
	}
	if _, err := h.HandleRPC("queue.remove", srRemoveRPC(trackID, "sr5"), ""); err != nil {
		t.Fatalf("flag-off remove dispatch: %v", err)
	}
}
