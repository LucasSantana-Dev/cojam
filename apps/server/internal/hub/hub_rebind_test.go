package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/cojam/server/internal/connauth"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/rebind"
)

// room.rebind (#172): guest-to-account upgrade with attribution rebind.
// Spec: docs/specs/172-guest-account-upgrade.md; decision record: ADR-0005.

const rebindTestSecret = "rebind-test-secret"

func newRebindHub(t *testing.T) *Hub {
	t.Helper()
	return NewHub(nil).WithRebind([]byte(rebindTestSecret), rebind.NewMemory())
}

func mintProof(t *testing.T, secret, sub string, ttl time.Duration) string {
	t.Helper()
	tok, err := connauth.Mint([]byte(secret), sub, ttl)
	if err != nil {
		t.Fatalf("mint proof: %v", err)
	}
	return tok
}

// joinAs enrolls a connection with the given identity in a room, the way
// RegisterClient + subscribe/room.join do on the live path.
func joinAs(h *Hub, clientID, userID, roomID string) {
	h.RecordClientUserID(clientID, userID)
	h.Join(clientID, roomID)
}

// disconnectAs mirrors the OnDisconnect cleanup for a departing connection.
func disconnectAs(h *Hub, clientID string) {
	h.Leave(clientID)
	h.RemoveClientUserID(clientID)
}

// rebindCall issues room.rebind over the transport-independent dispatch.
func rebindCall(h *Hub, roomID, proof, clientID, userID string) (json.RawMessage, error) {
	payload, _ := json.Marshal(map[string]string{"roomId": roomID, "proof": proof})
	return h.handleRPC("room.rebind", payload, clientID, userID)
}

// rebindState returns a deep copy of the room state (safe to read unlocked).
func rebindState(t *testing.T, h *Hub, roomID string) *queue.RoomState {
	t.Helper()
	room := mustRoom(t, h, roomID)
	room.mu.Lock()
	defer room.mu.Unlock()
	data, err := json.Marshal(room.State)
	if err != nil {
		t.Fatalf("marshal state: %v", err)
	}
	var s queue.RoomState
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatalf("unmarshal state: %v", err)
	}
	return &s
}

func rebindVersion(t *testing.T, h *Hub, roomID string) int64 {
	t.Helper()
	return rebindState(t, h, roomID).Version
}

// queueTrack adds one track as the given identity and returns its server id.
func queueTrack(t *testing.T, h *Hub, roomID, clientID, userID, title string) string {
	t.Helper()
	payload, _ := json.Marshal(map[string]interface{}{
		"roomId": roomID,
		"track":  map[string]interface{}{"title": title, "artist": "A", "sources": map[string]interface{}{}, "addedBy": "n"},
	})
	res, err := h.handleRPC("queue.add", payload, clientID, userID)
	if err != nil {
		t.Fatalf("queue.add %s: %v", title, err)
	}
	var state struct {
		Queue []struct {
			ID string `json:"id"`
		} `json:"queue"`
	}
	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("unmarshal queue.add: %v", err)
	}
	return state.Queue[len(state.Queue)-1].ID
}

// setupGuestRoom creates a room where a guest (anonymous sub) queued two
// tracks, then signed in: the old anonymous connection is gone and the new
// connection carries the authenticated identity.
func setupGuestRoom(t *testing.T, h *Hub, roomID, guestSub, authUser string) {
	t.Helper()
	joinAs(h, "c-guest", guestSub, roomID)
	queueTrack(t, h, roomID, "c-guest", guestSub, "T1")
	queueTrack(t, h, roomID, "c-guest", guestSub, "T2")
	disconnectAs(h, "c-guest")
	joinAs(h, "c-auth", authUser, roomID)
}

func TestRebind_MethodNotFoundWhenNotWired(t *testing.T) {
	h := NewHub(nil) // no WithRebind: FEATURE_ROOM_AUTH off posture
	_, err := rebindCall(h, "room", "proof", "c-auth", "sb:u1")
	if !errors.Is(err, centrifuge.ErrorMethodNotFound) {
		t.Fatalf("unwired rebind: got %v, want ErrorMethodNotFound", err)
	}
}

func TestRebind_MembershipGated(t *testing.T) {
	if !mutatingMethods["room.rebind"] {
		t.Fatal("room.rebind must be in mutatingMethods (membership gate)")
	}
	h := newRebindHub(t)
	proof := mintProof(t, rebindTestSecret, "guestsub", 24*time.Hour)
	payload, _ := json.Marshal(map[string]string{"roomId": "room", "proof": proof})
	err := h.Authorize(newTestClient("c-outsider", "sb:u1"), "room.rebind", payload)
	if !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("non-member rebind: got %v, want ErrorPermissionDenied", err)
	}
}

func TestRebind_UnauthenticatedRejected(t *testing.T) {
	h := newRebindHub(t)
	proof := mintProof(t, rebindTestSecret, "guestsub", 24*time.Hour)

	// No identity at all (room auth off transport path).
	if _, err := rebindCall(h, "room", proof, "c-x", ""); err == nil {
		t.Fatal("rebind with empty userID must be rejected")
	}
	// An anonymous identity has nothing to upgrade to.
	if _, err := rebindCall(h, "room", proof, "c-x", "guestsub"); err == nil {
		t.Fatal("rebind from a non-account identity must be rejected")
	}
	// Nothing was consumed or mutated.
	if consumed, _ := h.rebindBurns.Consumed(context.Background(), "guestsub"); consumed {
		t.Fatal("rejected rebind must not burn the sub")
	}
}

func TestRebind_MissingProofRejected(t *testing.T) {
	h := newRebindHub(t)
	if _, err := rebindCall(h, "room", "", "c-auth", "sb:u1"); err == nil {
		t.Fatal("rebind without a proof token must be rejected")
	}
}

func TestRebind_ForgedProofRejected(t *testing.T) {
	h := newRebindHub(t)
	// Signed with the wrong secret: proves nothing.
	forged := mintProof(t, "attacker-secret", "guestsub", 24*time.Hour)
	if _, err := rebindCall(h, "room", forged, "c-auth", "sb:u1"); err == nil {
		t.Fatal("forged proof must be rejected")
	}
	if consumed, _ := h.rebindBurns.Consumed(context.Background(), "guestsub"); consumed {
		t.Fatal("rejected rebind must not burn the sub")
	}
}

func TestRebind_ExpiredBeyondGraceRejected(t *testing.T) {
	h := newRebindHub(t)
	stale := mintProof(t, rebindTestSecret, "guestsub", -31*24*time.Hour)
	if _, err := rebindCall(h, "room", stale, "c-auth", "sb:u1"); err == nil {
		t.Fatal("proof expired beyond the refresh grace must be rejected")
	}
}

func TestRebind_ExpiredWithinGraceStillUpgrades(t *testing.T) {
	h := newRebindHub(t)
	setupGuestRoom(t, h, "room", "guestsub", "sb:u1")
	proof := mintProof(t, rebindTestSecret, "guestsub", -1*time.Hour) // expired 1h ago, inside the 30d grace

	if _, err := rebindCall(h, "room", proof, "c-auth", "sb:u1"); err != nil {
		t.Fatalf("expired-within-grace proof must still upgrade: %v", err)
	}
	state := rebindState(t, h, "room")
	for _, tr := range state.Queue {
		if tr.AddedByUserID != "sb:u1" {
			t.Fatalf("track %q owner = %q, want sb:u1", tr.Title, tr.AddedByUserID)
		}
	}
}

func TestRebind_CollisionRejected(t *testing.T) {
	h := newRebindHub(t)
	joinAs(h, "c-guest", "guestsub", "room")
	queueTrack(t, h, "room", "c-guest", "guestsub", "T1")
	// The account is already present on another connection (second tab).
	joinAs(h, "c-other-tab", "sb:u1", "room")
	joinAs(h, "c-auth", "sb:u1", "room")
	versionBefore := rebindVersion(t, h, "room")

	proof := mintProof(t, rebindTestSecret, "guestsub", 24*time.Hour)
	_, err := rebindCall(h, "room", proof, "c-auth", "sb:u1")
	if err == nil {
		t.Fatal("collision with the same account on another connection must be rejected")
	}
	var ue *UserError
	if !errors.As(err, &ue) || ue.Error() != "This account is already in this room from another tab or device. Close it and retry." {
		t.Fatalf("collision message: got %v", err)
	}
	if v := rebindVersion(t, h, "room"); v != versionBefore {
		t.Fatalf("collision must change nothing: version %d -> %d", versionBefore, v)
	}
	if consumed, _ := h.rebindBurns.Consumed(context.Background(), "guestsub"); consumed {
		t.Fatal("collision rejection must not burn the sub (retry once the conflict clears)")
	}
}

func TestRebind_HappyPathAcrossReconnect(t *testing.T) {
	h := newRebindHub(t)
	setupGuestRoom(t, h, "room", "guestsub", "sb:u1")
	versionBefore := rebindVersion(t, h, "room")

	proof := mintProof(t, rebindTestSecret, "guestsub", 24*time.Hour)
	res, err := rebindCall(h, "room", proof, "c-auth", "sb:u1")
	if err != nil {
		t.Fatalf("rebind: %v", err)
	}
	// The RPC result is the full RoomState, same as every mutation.
	var published queue.RoomState
	if err := json.Unmarshal(res, &published); err != nil {
		t.Fatalf("rebind result must be RoomState: %v", err)
	}

	state := rebindState(t, h, "room")
	if len(state.Queue) != 2 {
		t.Fatalf("queue length: got %d, want 2", len(state.Queue))
	}
	for _, tr := range state.Queue {
		if tr.AddedByUserID != "sb:u1" {
			t.Fatalf("track %q owner = %q, want sb:u1", tr.Title, tr.AddedByUserID)
		}
		// AddedBy display strings are not rewritten: they remain a true
		// record of the name in use at add time.
		if tr.AddedBy != "n" {
			t.Fatalf("track %q addedBy = %q, want unchanged %q", tr.Title, tr.AddedBy, "n")
		}
	}
	if state.Version != versionBefore+1 {
		t.Fatalf("version = %d, want exactly one bump from %d", state.Version, versionBefore)
	}
}

func TestRebind_HostMoves(t *testing.T) {
	h := newRebindHub(t)
	joinAs(h, "c-guest", "guestsub", "room")
	room := mustRoom(t, h, "room")
	room.mu.Lock()
	room.State.HostUserID = "guestsub"
	room.mu.Unlock()
	disconnectAs(h, "c-guest")
	joinAs(h, "c-auth", "sb:u1", "room")

	proof := mintProof(t, rebindTestSecret, "guestsub", 24*time.Hour)
	if _, err := rebindCall(h, "room", proof, "c-auth", "sb:u1"); err != nil {
		t.Fatalf("rebind: %v", err)
	}
	if host := rebindState(t, h, "room").HostUserID; host != "sb:u1" {
		t.Fatalf("HostUserID = %q, want sb:u1", host)
	}
	// The upgraded identity passes a host-only gate afterwards.
	payload, _ := json.Marshal(map[string]string{"roomId": "room"})
	if err := h.Authorize(newTestClient("c-auth", "sb:u1"), "radio.set", payload); err != nil {
		t.Fatalf("upgraded host must pass host-only checks: %v", err)
	}
}

func TestRebind_VotesRewritten(t *testing.T) {
	h := newRebindHub(t).WithVoting(true)
	joinAs(h, "c-guest", "guestsub", "room")
	trackID := queueTrack(t, h, "room", "c-guest", "guestsub", "T1")
	votePayload, _ := json.Marshal(map[string]string{"roomId": "room", "trackId": trackID})
	if _, err := h.handleRPC("queue.vote", votePayload, "c-guest", "guestsub"); err != nil {
		t.Fatalf("guest vote: %v", err)
	}
	if voters := rebindState(t, h, "room").Votes[trackID]; len(voters) != 1 || voters[0] != "user:guestsub" {
		t.Fatalf("pre-rebind voters = %v, want [user:guestsub]", voters)
	}
	disconnectAs(h, "c-guest")
	joinAs(h, "c-auth", "sb:u1", "room")

	proof := mintProof(t, rebindTestSecret, "guestsub", 24*time.Hour)
	if _, err := rebindCall(h, "room", proof, "c-auth", "sb:u1"); err != nil {
		t.Fatalf("rebind: %v", err)
	}
	if voters := rebindState(t, h, "room").Votes[trackID]; len(voters) != 1 || voters[0] != "user:sb:u1" {
		t.Fatalf("post-rebind voters = %v, want [user:sb:u1]", voters)
	}

	// No double vote: the upgraded member voting the same track toggles the
	// existing (moved) vote off instead of adding a second entry.
	if _, err := h.handleRPC("queue.vote", votePayload, "c-auth", "sb:u1"); err != nil {
		t.Fatalf("post-rebind vote: %v", err)
	}
	if voters := rebindState(t, h, "room").Votes[trackID]; len(voters) != 0 {
		t.Fatalf("after toggling, voters = %v, want none (no double vote)", voters)
	}
}

func TestRebind_SeniorityTransferred(t *testing.T) {
	h := newRebindHub(t)
	room := setupHandoffRoom(t, h, "room", "c-host", "sb:host",
		map[string]string{"c-other": "sb:other", "c-guest": "guestsub"},
		map[string]int64{"guestsub": 100, "sb:other": 200})
	_ = room
	disconnectAs(h, "c-guest")
	// The new connection joins at the rebind instant; the transfer must
	// replace that with the guest's older standing.
	joinAs(h, "c-auth", "sb:new", "room")

	proof := mintProof(t, rebindTestSecret, "guestsub", 24*time.Hour)
	if _, err := rebindCall(h, "room", proof, "c-auth", "sb:new"); err != nil {
		t.Fatalf("rebind: %v", err)
	}

	h.memberMu.RLock()
	got, ok := h.memberJoinTimes["room"]["sb:new"]
	_, oldGone := h.memberJoinTimes["room"]["guestsub"]
	h.memberMu.RUnlock()
	if !ok || got != 100 {
		t.Fatalf("memberJoinTimes[sb:new] = %d (ok=%v), want the guest's 100", got, ok)
	}
	if oldGone {
		t.Fatal("the rebound sub's join time must be removed")
	}

	// Longest-present promotion: the upgraded member (100) outranks the
	// member who joined later (200) when the host disconnects.
	h.PromoteOnDisconnect("c-host")
	if host := rebindState(t, h, "room").HostUserID; host != "sb:new" {
		t.Fatalf("promoted host = %q, want sb:new (longest present)", host)
	}
}

func TestRebind_ZombieConnectionsDisconnected(t *testing.T) {
	h := newRebindHub(t)
	setupGuestRoom(t, h, "room", "guestsub", "sb:u1")
	// A second tab still holds an anonymous connection under the old sub.
	joinAs(h, "c-zombie", "guestsub", "room")

	proof := mintProof(t, rebindTestSecret, "guestsub", 24*time.Hour)
	if _, err := rebindCall(h, "room", proof, "c-auth", "sb:u1"); err != nil {
		t.Fatalf("rebind: %v", err)
	}

	// The zombie was kicked via the room.kick mechanism: its membership in
	// the room is dropped (with a live node the connection is closed too).
	if h.IsMember("c-zombie", "room") {
		t.Fatal("zombie connection must be disconnected from the room after rebind")
	}
	if !h.IsMember("c-auth", "room") {
		t.Fatal("the upgrading connection must stay a member")
	}
}

func TestRebind_BurnRejectsReuse(t *testing.T) {
	h := newRebindHub(t)
	setupGuestRoom(t, h, "room", "guestsub", "sb:u1")
	// The same guest also contributed to a second room.
	joinAs(h, "c-guest-b", "guestsub", "room-b")
	queueTrack(t, h, "room-b", "c-guest-b", "guestsub", "TB")
	disconnectAs(h, "c-guest-b")
	joinAs(h, "c-auth-b", "sb:u1", "room-b")

	proof := mintProof(t, rebindTestSecret, "guestsub", 24*time.Hour)
	if _, err := rebindCall(h, "room", proof, "c-auth", "sb:u1"); err != nil {
		t.Fatalf("first rebind: %v", err)
	}

	// Reuse of the consumed sub is rejected, in any room.
	if _, err := rebindCall(h, "room", proof, "c-auth", "sb:u1"); err == nil {
		t.Fatal("rebind reusing a consumed sub must be rejected")
	}
	if _, err := rebindCall(h, "room-b", proof, "c-auth-b", "sb:u1"); err == nil {
		t.Fatal("consumed sub must be rejected across rooms too")
	}

	// Decision A: the room the guest is not rebinding keeps its historical
	// attribution untouched.
	for _, tr := range rebindState(t, h, "room-b").Queue {
		if tr.AddedByUserID != "guestsub" {
			t.Fatalf("left-room track owner = %q, want unchanged guestsub", tr.AddedByUserID)
		}
	}
}

// Decision C regression: the request carries no identity string. A payload
// naming another guest's identity must not move that guest's attribution;
// the old identity comes solely from the signature-verified sub. This test
// must fail if a client-supplied identity field is ever honored.
func TestRebind_ClientCannotNameIdentity(t *testing.T) {
	h := newRebindHub(t)
	joinAs(h, "c-victim", "victimsub", "room")
	queueTrack(t, h, "room", "c-victim", "victimsub", "VictimTrack")
	disconnectAs(h, "c-victim")
	joinAs(h, "c-guest", "guestsub", "room")
	queueTrack(t, h, "room", "c-guest", "guestsub", "GuestTrack")
	disconnectAs(h, "c-guest")
	joinAs(h, "c-auth", "sb:u1", "room")

	proof := mintProof(t, rebindTestSecret, "guestsub", 24*time.Hour)
	payload := []byte(`{"roomId":"room","proof":"` + proof + `","oldUserId":"victimsub"}`)
	if _, err := h.handleRPC("room.rebind", payload, "c-auth", "sb:u1"); err != nil {
		t.Fatalf("rebind: %v", err)
	}

	owners := map[string]string{}
	for _, tr := range rebindState(t, h, "room").Queue {
		owners[tr.Title] = tr.AddedByUserID
	}
	if owners["VictimTrack"] != "victimsub" {
		t.Fatalf("client-named identity was honored: victim track owner = %q", owners["VictimTrack"])
	}
	if owners["GuestTrack"] != "sb:u1" {
		t.Fatalf("verified sub not applied: guest track owner = %q", owners["GuestTrack"])
	}
}

// Race detector coverage: concurrent joins, adds, and rebinds must serialize
// cleanly (run with -race).
func TestRebind_ConcurrentJoinAddRebind(t *testing.T) {
	h := newRebindHub(t).WithVoting(true)
	joinAs(h, "c-guest", "guestsub", "room")
	proof := mintProof(t, rebindTestSecret, "guestsub", 24*time.Hour)

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			clientID := fmt.Sprintf("c-add-%d", i)
			userID := fmt.Sprintf("sb:add-%d", i)
			joinAs(h, clientID, userID, "room")
			payload, _ := json.Marshal(map[string]interface{}{
				"roomId": "room",
				"track":  map[string]interface{}{"title": "T", "artist": "A", "sources": map[string]interface{}{}, "addedBy": "n"},
			})
			_, _ = h.handleRPC("queue.add", payload, clientID, userID)
		}(i)
	}
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			clientID := fmt.Sprintf("c-rebind-%d", i)
			userID := fmt.Sprintf("sb:rebind-%d", i)
			joinAs(h, clientID, userID, "room")
			// One wins the burn; the other is rejected. Both are fine here.
			_, _ = rebindCall(h, "room", proof, clientID, userID)
		}(i)
	}
	wg.Wait()
}
