package hub

import (
	"encoding/json"
	"fmt"
	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// Vote-to-skip (now_playing.vote_skip). Any member may vote to skip the
// playing track; the host keeps the direct skip (now_playing.advance). The
// votes live in RoomState.SkipVotes (voter keys stamped like queue.vote:
// "user:<userID>" or "client:<clientID>") and reset on every track change.
//
// Threshold: queue.SkipVotesNeeded of n, where n is the number of DISTINCT
// listeners present (two tabs of one user count once, the same identity the
// room page's "N ouvindo" collapses by). Only votes from currently present
// voters count, and the threshold is re-evaluated when a listener leaves, so a
// departure can complete the vote. Reaching it advances exactly like the host
// skip (advanceAfterReport: same dedup against auto-advance, the transport is
// re-anchored by setNowPlayingID and mutateRoom).
//
// The method rides the queue voting flag (WithVoting) and the queue.vote
// bucket: it is the same listener input channel, so one switch and one
// budget cover both.

// presentVoterKeys is the set of distinct listener identities currently in the
// room, in the voter-key format of queue.vote. It takes memberMu before any
// room lock (the hub lock order).
func (h *Hub) presentVoterKeys(roomID string) map[string]bool {
	h.memberMu.RLock()
	defer h.memberMu.RUnlock()
	h.clientUserIDMu.RLock()
	defer h.clientUserIDMu.RUnlock()
	present := make(map[string]bool, len(h.roomMembers[roomID]))
	for clientID := range h.roomMembers[roomID] {
		present[rateLimitKey(clientID, h.clientUserID[clientID])] = true
	}
	return present
}

// voteSkipRPC handles now_playing.vote_skip: {roomId, nowPlayingId, vote?}.
// vote omitted toggles; true/false set the value (idempotent, so a client that
// lost track of its own state cannot invert it).
func (h *Hub) voteSkipRPC(data []byte, clientID, voter string) (json.RawMessage, error) {
	if !h.votingEnabled {
		return nil, centrifuge.ErrorMethodNotFound
	}
	var req struct {
		RoomID       string `json:"roomId"`
		NowPlayingID string `json:"nowPlayingId"`
		Vote         *bool  `json:"vote"`
	}
	if err := json.Unmarshal(data, &req); err != nil {
		return nil, err
	}
	if req.RoomID == "" {
		return nil, fmt.Errorf("now_playing.vote_skip: roomId required")
	}
	if req.NowPlayingID == "" {
		return nil, fmt.Errorf("now_playing.vote_skip: nowPlayingId required")
	}
	// Authorize enforces this at the transport; re-checked for the
	// transport-independent path, like reaction.woot.
	if clientID == "" || !h.IsMember(clientID, req.RoomID) {
		return nil, userErrorf("not a member of this room")
	}
	return h.skipVoteStep(req.RoomID, req.NowPlayingID, voter, req.Vote)
}

// reevaluateSkipVotes re-runs the vote after a membership change. It is a
// cheap no-op for a room that is not resident or has no skip votes, and never
// creates a room.
func (h *Hub) reevaluateSkipVotes(roomID string) {
	if !h.votingEnabled {
		return
	}
	h.mu.RLock()
	room, ok := h.rooms[roomID]
	h.mu.RUnlock()
	if !ok {
		return
	}
	room.mu.Lock()
	has := len(room.State.SkipVotes) > 0
	room.mu.Unlock()
	if !has {
		return
	}
	if _, err := h.skipVoteStep(roomID, "", "", nil); err != nil && h.logger != nil {
		h.logger.Info("skip_vote_reevaluate_failed", "room_id", roomID, "err", err.Error())
	}
}

// skipVoteStep applies one vote change (voter != "") and/or a prune of absent
// voters, then advances playback when the threshold is reached. expectID, when
// set, must still be the playing track: a stale id is rejected so a vote cast
// on the previous track never lands on the next one.
func (h *Hub) skipVoteStep(roomID, expectID, voter string, vote *bool) (json.RawMessage, error) {
	present := h.presentVoterKeys(roomID)
	need := queue.SkipVotesNeeded(len(present))

	var (
		reached   bool
		playingID string
		votes     int
		cast      bool
	)
	res, err := h.mutateNoSkip(roomID, func(s *queue.RoomState) error {
		if expectID != "" && s.NowPlayingID != expectID {
			return userErrorf("a música já mudou")
		}
		if s.NowPlayingID == "" {
			return nil
		}
		if voter != "" {
			want := !s.HasSkipVote(voter)
			if vote != nil {
				want = *vote
			}
			cast = s.SetSkipVote(voter, want) && want
		}
		s.PruneSkipVotes(present)
		votes = len(s.SkipVotes)
		playingID = s.NowPlayingID
		reached = votes > 0 && votes >= need
		return nil
	})
	if err != nil {
		return res, err
	}
	if cast && h.metrics != nil {
		h.metrics.SkipVoteCast()
	}
	if !reached {
		return res, nil
	}
	advRes, moved, err := h.advanceAfterReport(roomID, playingID, true, nil)
	if err != nil {
		return res, err
	}
	if moved {
		if h.metrics != nil {
			h.metrics.SkipByVote()
		}
		if h.logger != nil {
			h.logger.Info("skip_by_vote", "room_id", roomID, "votes", votes, "n", len(present))
		}
		h.publishSystemChat(roomID, "Música pulada pela sala")
	}
	return advRes, nil
}
