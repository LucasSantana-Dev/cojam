package hub

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

// setupVotingRoom creates a room with one track and returns the track ID.
// HandleRPC bypasses Authorize, so no membership enrollment is needed here.
func setupVotingRoom(t *testing.T, h *Hub, roomID string) string {
	t.Helper()
	if _, err := h.HandleRPC("room.join", []byte(fmt.Sprintf(`{"roomId":"%s","name":"alice"}`, roomID)), ""); err != nil {
		t.Fatalf("room.join: %v", err)
	}
	add := fmt.Sprintf(`{"roomId":"%s","track":{"title":"S","artist":"A","sources":{},"addedBy":"alice"}}`, roomID)
	res, err := h.HandleRPC("queue.add", []byte(add), "")
	if err != nil {
		t.Fatalf("queue.add: %v", err)
	}
	var state queue.RoomState
	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("unmarshal queue.add response: %v", err)
	}
	return state.Queue[0].ID
}

func votePayload(roomID, trackID string) []byte {
	return []byte(fmt.Sprintf(`{"roomId":"%s","trackId":"%s"}`, roomID, trackID))
}

// A non-member cannot vote: queue.vote is in mutatingMethods, so Authorize
// rejects it with PermissionDenied before dispatch.
func TestQueueVote_NonMemberRejected(t *testing.T) {
	h := NewHub(nil).WithVoting(true)
	trackID := setupVotingRoom(t, h, "vote_authz")

	err := h.Authorize(newTestClient("intruder", ""), "queue.vote", votePayload("vote_authz", trackID))
	if !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("non-member queue.vote: got %v, want ErrorPermissionDenied", err)
	}
}

// Voting is the listener's input channel: queue.vote is NOT host-only, so a
// non-host member can vote even when a host is set.
func TestQueueVote_ListenerCanVote(t *testing.T) {
	h := NewHub(nil).WithVoting(true)

	// alice joins with auth and becomes host.
	h.RecordClientUserID("alice_client", "alice")
	h.Join("alice_client", "vote_host")
	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"vote_host","name":"alice"}`), "alice"); err != nil {
		t.Fatalf("room.join alice: %v", err)
	}

	// bob joins as a listener (member, not host).
	h.RecordClientUserID("bob_client", "bob")
	h.Join("bob_client", "vote_host")
	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"vote_host","name":"bob"}`), "bob"); err != nil {
		t.Fatalf("room.join bob: %v", err)
	}

	res, err := h.HandleRPC("queue.add", []byte(`{"roomId":"vote_host","track":{"title":"S","artist":"A","sources":{},"addedBy":"alice"}}`), "alice")
	if err != nil {
		t.Fatalf("queue.add: %v", err)
	}
	var state queue.RoomState
	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("unmarshal queue.add response: %v", err)
	}
	trackID := state.Queue[0].ID

	bobClient := newTestClient("bob_client", "bob")
	if err := h.Authorize(bobClient, "queue.vote", votePayload("vote_host", trackID)); err != nil {
		t.Fatalf("listener queue.vote must be allowed (not host-only): %v", err)
	}

	if _, err := h.handleRPC("queue.vote", votePayload("vote_host", trackID), "bob", rateLimitKey("bob_client", "bob")); err != nil {
		t.Fatalf("listener queue.vote: %v", err)
	}
}

// Gotcha #2 regression: a published mutation must bump Version or the web
// version guard drops it and votes are invisible until reload.
func TestQueueVote_BumpsVersion(t *testing.T) {
	h := NewHub(nil).WithVoting(true)
	trackID := setupVotingRoom(t, h, "vote_ver")

	room := h.GetOrCreateRoom("vote_ver")
	room.mu.Lock()
	before := room.State.Version
	room.mu.Unlock()

	res, err := h.HandleRPC("queue.vote", votePayload("vote_ver", trackID), "alice")
	if err != nil {
		t.Fatalf("queue.vote: %v", err)
	}
	var state queue.RoomState
	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("unmarshal queue.vote response: %v", err)
	}
	if state.Version != before+1 {
		t.Fatalf("version after vote: got %d, want %d (bump on every published mutation)", state.Version, before+1)
	}
	if got := len(state.Votes[trackID]); got != 1 {
		t.Fatalf("vote count: got %d, want 1", got)
	}
}

// One vote per voter per track is structural: a voter's second toggle removes
// their vote; distinct voter keys each count once.
func TestQueueVote_TogglePerVoter(t *testing.T) {
	h := NewHub(nil).WithVoting(true)
	trackID := setupVotingRoom(t, h, "vote_toggle")

	vote := func(userID string) queue.RoomState {
		t.Helper()
		res, err := h.HandleRPC("queue.vote", votePayload("vote_toggle", trackID), userID)
		if err != nil {
			t.Fatalf("queue.vote %s: %v", userID, err)
		}
		var state queue.RoomState
		if err := json.Unmarshal(res, &state); err != nil {
			t.Fatalf("unmarshal queue.vote response: %v", err)
		}
		return state
	}

	if got := len(vote("alice").Votes[trackID]); got != 1 {
		t.Fatalf("after alice votes: count %d, want 1", got)
	}
	state := vote("bob")
	if got := len(state.Votes[trackID]); got != 2 {
		t.Fatalf("after bob votes: count %d, want 2 (distinct voter keys)", got)
	}
	state = vote("alice")
	if got := len(state.Votes[trackID]); got != 1 {
		t.Fatalf("after alice votes again (toggle off): count %d, want 1", got)
	}
	if state.Votes[trackID][0] != "user:bob" {
		t.Fatalf("remaining voter: got %q, want user:bob", state.Votes[trackID][0])
	}
}

// The voter key is server-stamped from the connection identity, never
// client-supplied: an anonymous caller votes as "client:<clientID>".
func TestQueueVote_GuestVoterKey(t *testing.T) {
	h := NewHub(nil).WithVoting(true)
	trackID := setupVotingRoom(t, h, "vote_guest")

	res, err := h.handleRPC("queue.vote", votePayload("vote_guest", trackID), "", rateLimitKey("anon_client", ""))
	if err != nil {
		t.Fatalf("guest queue.vote: %v", err)
	}
	var state queue.RoomState
	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("unmarshal queue.vote response: %v", err)
	}
	voters := state.Votes[trackID]
	if len(voters) != 1 || voters[0] != "client:anon_client" {
		t.Fatalf("guest voter key: got %v, want [client:anon_client]", voters)
	}
}

// Unknown track surfaces as a client-visible UserError, not a masked internal.
func TestQueueVote_UnknownTrack(t *testing.T) {
	h := NewHub(nil).WithVoting(true)
	setupVotingRoom(t, h, "vote_missing")

	_, err := h.HandleRPC("queue.vote", votePayload("vote_missing", "nope"), "alice")
	var ue *UserError
	if !errors.As(err, &ue) {
		t.Fatalf("queue.vote on unknown track: got %T (%v), want *UserError", err, err)
	}
}

// Votes persist with the rest of RoomState through the store (whole-state
// marshal), so they survive a hub restart.
func TestQueueVote_PersistsAcrossRestart(t *testing.T) {
	s := store.NewMemory()
	h1 := NewHub(nil).WithStore(s).WithVoting(true)
	trackID := setupVotingRoom(t, h1, "vote_persist")

	if _, err := h1.HandleRPC("queue.vote", votePayload("vote_persist", trackID), "alice"); err != nil {
		t.Fatalf("queue.vote: %v", err)
	}

	// A fresh hub on the same store reloads the room from disk, not memory.
	h2 := NewHub(nil).WithStore(s).WithVoting(true)
	room := h2.GetOrCreateRoom("vote_persist")
	room.mu.Lock()
	defer room.mu.Unlock()
	voters := room.State.Votes[trackID]
	if len(voters) != 1 || voters[0] != "user:alice" {
		t.Fatalf("votes after reload: got %v, want [user:alice]", voters)
	}
}

// Votes get their own per-caller bucket: after the burst the next toggle is
// rejected with a UserError, and the fanout budget is untouched.
func TestQueueVote_RateLimited(t *testing.T) {
	h := NewHub(nil).WithVoting(true)
	clock := &fakeClock{now: time.Now()}
	h.voteLimiter = newRateLimiter(2, time.Hour, clock.Now) // no refill during the test

	trackID := setupVotingRoom(t, h, "vote_rl")

	for i := 0; i < 2; i++ {
		if _, err := h.HandleRPC("queue.vote", votePayload("vote_rl", trackID), "alice"); err != nil {
			t.Fatalf("vote %d within burst: %v", i+1, err)
		}
	}

	_, err := h.HandleRPC("queue.vote", votePayload("vote_rl", trackID), "alice")
	var ue *UserError
	if !errors.As(err, &ue) {
		t.Fatalf("vote past burst: got %T (%v), want *UserError", err, err)
	}

	// A different voter has their own bucket.
	if _, err := h.HandleRPC("queue.vote", votePayload("vote_rl", trackID), "bob"); err != nil {
		t.Fatalf("bob's first vote must succeed: %v", err)
	}
}

// WithVoting(false) (the default) dark-ships the RPC: ErrorMethodNotFound,
// same as transport.* behind FEATURE_SYNC.
func TestQueueVote_FlagOffMethodNotFound(t *testing.T) {
	h := NewHub(nil)
	trackID := setupVotingRoom(t, h, "vote_off")

	_, err := h.HandleRPC("queue.vote", votePayload("vote_off", trackID), "alice")
	if !errors.Is(err, centrifuge.ErrorMethodNotFound) {
		t.Fatalf("queue.vote with flag off: got %v, want ErrorMethodNotFound", err)
	}
}
