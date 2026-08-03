package hub

import (
	"encoding/json"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// #183: a disconnecting guest's votes die with the connection. Mirrors the
// main.go OnDisconnect order: PruneGuestVotes first (needs the membership
// list), then Leave.
func TestPruneGuestVotes_DisconnectRemovesGuestVotes(t *testing.T) {
	h := NewHub(nil).WithVoting(true)
	trackID := setupVotingRoom(t, h, "prune1")

	// A guest and an authenticated user vote on the same track.
	h.Join("guest1", "prune1")
	if _, err := h.handleRPC("queue.vote", votePayload("prune1", trackID), "guest1", ""); err != nil {
		t.Fatalf("guest queue.vote: %v", err)
	}
	if _, err := h.HandleRPC("queue.vote", votePayload("prune1", trackID), "alice"); err != nil {
		t.Fatalf("alice queue.vote: %v", err)
	}

	room := mustRoom(t, h, "prune1")
	room.mu.Lock()
	before := room.State.Version
	room.mu.Unlock()

	// Disconnect (main.go OnDisconnect order: prune, then leave).
	h.PruneGuestVotes("guest1")
	h.Leave("guest1")

	room.mu.Lock()
	defer room.mu.Unlock()
	voters := room.State.Votes[trackID]
	if len(voters) != 1 || voters[0] != "user:alice" {
		t.Fatalf("votes after disconnect: got %v, want [user:alice]", voters)
	}
	// Votes are published RoomState: the prune must bump Version or
	// version-guarded clients would keep the ghost vote until reload.
	if room.State.Version != before+1 {
		t.Fatalf("version after prune: got %d, want %d", room.State.Version, before+1)
	}
}

// #183: without the prune a reconnecting guest (new clientID) could vote
// again while their old key still counts; with it the track holds exactly
// one vote at any time.
func TestPruneGuestVotes_ReconnectCannotDoubleVote(t *testing.T) {
	h := NewHub(nil).WithVoting(true)
	trackID := setupVotingRoom(t, h, "prune2")

	h.Join("guest1", "prune2")
	if _, err := h.handleRPC("queue.vote", votePayload("prune2", trackID), "guest1", ""); err != nil {
		t.Fatalf("guest1 queue.vote: %v", err)
	}

	h.PruneGuestVotes("guest1")
	h.Leave("guest1")

	// The same human reconnects as a new connection and votes again.
	h.Join("guest2", "prune2")
	res, err := h.handleRPC("queue.vote", votePayload("prune2", trackID), "guest2", "")
	if err != nil {
		t.Fatalf("guest2 queue.vote: %v", err)
	}
	var state queue.RoomState
	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("unmarshal queue.vote response: %v", err)
	}
	voters := state.Votes[trackID]
	if len(voters) != 1 || voters[0] != "client:guest2" {
		t.Fatalf("votes after reconnect: got %v, want [client:guest2]", voters)
	}
}

// #183: a guest who never voted changes nothing on disconnect — no Version
// bump, so mutate skips the save + broadcast entirely.
func TestPruneGuestVotes_NoVoteIsNoOp(t *testing.T) {
	h := NewHub(nil).WithVoting(true)
	setupVotingRoom(t, h, "prune3")

	h.Join("guest1", "prune3")
	room := mustRoom(t, h, "prune3")
	room.mu.Lock()
	before := room.State.Version
	room.mu.Unlock()

	h.PruneGuestVotes("guest1")
	h.Leave("guest1")

	room.mu.Lock()
	defer room.mu.Unlock()
	if room.State.Version != before {
		t.Fatalf("version after no-op prune: got %d, want unchanged %d", room.State.Version, before)
	}
}

// #183: prune is scoped to the disconnecting guest — another guest's vote in
// the same room is untouched.
func TestPruneGuestVotes_ScopedToClientAndRooms(t *testing.T) {
	h := NewHub(nil).WithVoting(true)
	trackID := setupVotingRoom(t, h, "prune4")

	h.Join("guest1", "prune4")
	h.Join("guest2", "prune4")
	if _, err := h.handleRPC("queue.vote", votePayload("prune4", trackID), "guest1", ""); err != nil {
		t.Fatalf("guest1 queue.vote: %v", err)
	}
	if _, err := h.handleRPC("queue.vote", votePayload("prune4", trackID), "guest2", ""); err != nil {
		t.Fatalf("guest2 queue.vote: %v", err)
	}

	h.PruneGuestVotes("guest1")
	h.Leave("guest1")

	room := mustRoom(t, h, "prune4")
	room.mu.Lock()
	defer room.mu.Unlock()
	voters := room.State.Votes[trackID]
	if len(voters) != 1 || voters[0] != "client:guest2" {
		t.Fatalf("votes after guest1 disconnect: got %v, want [client:guest2]", voters)
	}
}

// #232: with FEATURE_ROOM_AUTH on, a guest connects with an anonymous sub and
// votes under "user:<anonSub>"; the prune must resolve the same key
// rateLimitKey does, or it silently matches nothing.
func TestPruneGuestVotes_RoomAuthGuestVotesPruned(t *testing.T) {
	h := NewHub(nil).WithVoting(true)
	trackID := setupVotingRoom(t, h, "prune5")

	h.Join("guest1", "prune5")
	h.RecordClientUserID("guest1", "anonSub1")
	if _, err := h.handleRPC("queue.vote", votePayload("prune5", trackID), "guest1", "anonSub1"); err != nil {
		t.Fatalf("room-auth guest queue.vote: %v", err)
	}
	room := mustRoom(t, h, "prune5")
	room.mu.Lock()
	if voters := room.State.Votes[trackID]; len(voters) != 1 || voters[0] != "user:anonSub1" {
		room.mu.Unlock()
		t.Fatalf("votes before disconnect: got %v, want [user:anonSub1]", voters)
	}
	before := room.State.Version
	room.mu.Unlock()

	h.PruneGuestVotes("guest1")
	h.Leave("guest1")

	room.mu.Lock()
	defer room.mu.Unlock()
	if voters := room.State.Votes[trackID]; len(voters) != 0 {
		t.Fatalf("votes after room-auth guest disconnect: got %v, want none", voters)
	}
	if room.State.Version != before+1 {
		t.Fatalf("version after prune: got %d, want %d", room.State.Version, before+1)
	}
}

// #232: an authenticated "sb:<uuid>" identity survives reconnects, so its
// votes must not be pruned on disconnect.
func TestPruneGuestVotes_AuthenticatedUserVotesSurvive(t *testing.T) {
	h := NewHub(nil).WithVoting(true)
	trackID := setupVotingRoom(t, h, "prune6")

	h.Join("alice-conn", "prune6")
	h.RecordClientUserID("alice-conn", "sb:alice-uuid")
	if _, err := h.handleRPC("queue.vote", votePayload("prune6", trackID), "alice-conn", "sb:alice-uuid"); err != nil {
		t.Fatalf("authenticated queue.vote: %v", err)
	}
	room := mustRoom(t, h, "prune6")
	room.mu.Lock()
	before := room.State.Version
	room.mu.Unlock()

	h.PruneGuestVotes("alice-conn")
	h.Leave("alice-conn")

	room.mu.Lock()
	defer room.mu.Unlock()
	voters := room.State.Votes[trackID]
	if len(voters) != 1 || voters[0] != "user:sb:alice-uuid" {
		t.Fatalf("votes after authenticated disconnect: got %v, want [user:sb:alice-uuid]", voters)
	}
	if room.State.Version != before {
		t.Fatalf("version after no-op prune: got %d, want unchanged %d", room.State.Version, before)
	}
}

// #232 + #172 ordering: a rebind that completed before the disconnect already
// rewrote the guest's keys to "user:<sb:...>", so pruning the dead anonymous
// key is a no-op and the claimed votes survive.
func TestPruneGuestVotes_RebindClaimedVotesSurvive(t *testing.T) {
	h := NewHub(nil).WithVoting(true)
	trackID := setupVotingRoom(t, h, "prune7")

	h.Join("guest1", "prune7")
	h.RecordClientUserID("guest1", "anonSub1")
	if _, err := h.handleRPC("queue.vote", votePayload("prune7", trackID), "guest1", "anonSub1"); err != nil {
		t.Fatalf("room-auth guest queue.vote: %v", err)
	}

	// The rebind commits first: keys move to the authenticated identity.
	if _, err := h.mutate("prune7", func(s *queue.RoomState) error {
		s.RewriteVoter("user:anonSub1", "user:sb:alice-uuid")
		s.Version++
		return nil
	}); err != nil {
		t.Fatalf("rebind mutate: %v", err)
	}

	// Then the anonymous connection's disconnect fires the prune.
	h.PruneGuestVotes("guest1")
	h.Leave("guest1")

	room := mustRoom(t, h, "prune7")
	room.mu.Lock()
	defer room.mu.Unlock()
	voters := room.State.Votes[trackID]
	if len(voters) != 1 || voters[0] != "user:sb:alice-uuid" {
		t.Fatalf("votes after rebind + disconnect: got %v, want [user:sb:alice-uuid]", voters)
	}
}
