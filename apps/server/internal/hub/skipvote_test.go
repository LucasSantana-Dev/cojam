package hub

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

func TestSkipVotesNeeded(t *testing.T) {
	cases := []struct{ n, want int }{{0, 0}, {1, 1}, {2, 2}, {3, 2}, {4, 2}, {5, 3}, {6, 3}, {7, 4}, {10, 5}}
	for _, c := range cases {
		if got := queue.SkipVotesNeeded(c.n); got != c.want {
			t.Errorf("SkipVotesNeeded(%d) = %d, want %d", c.n, got, c.want)
		}
	}
}

// skipRoom builds a voting room with `tracks` queued tracks and one listener
// per entry of users (clientID -> userID), all joined. Returns the hub and
// the first track's id.
func skipRoom(t *testing.T, roomID string, tracks int, users map[string]string) (*Hub, string) {
	t.Helper()
	h := NewHub(nil).WithVoting(true)
	h.skipGrace = 0 // checks run inline
	for client, user := range users {
		h.RecordClientUserID(client, user)
		h.Join(client, roomID)
	}
	var first string
	for i := 0; i < tracks; i++ {
		add := fmt.Sprintf(`{"roomId":"%s","track":{"title":"S%d","artist":"A","sources":{},"addedBy":"x"}}`, roomID, i)
		res, err := h.HandleRPC("queue.add", []byte(add), "")
		if err != nil {
			t.Fatalf("queue.add: %v", err)
		}
		if i == 0 {
			var st queue.RoomState
			_ = json.Unmarshal(res, &st)
			first = st.NowPlayingID
		}
	}
	return h, first
}

func skipPayload(roomID, id string) []byte {
	return []byte(fmt.Sprintf(`{"roomId":"%s","nowPlayingId":"%s"}`, roomID, id))
}

func skipVote(h *Hub, client, user, roomID, id string) (queue.RoomState, error) {
	res, err := h.serveRPC(newTestClient(client, user), "now_playing.vote_skip", skipPayload(roomID, id))
	var st queue.RoomState
	if err == nil {
		_ = json.Unmarshal(res, &st)
	}
	return st, err
}

func roomSnapshot(t *testing.T, h *Hub, roomID string) queue.RoomState {
	t.Helper()
	room := mustRoom(t, h, roomID)
	room.mu.Lock()
	defer room.mu.Unlock()
	cp := *room.State
	cp.SkipVotes = append([]string(nil), room.State.SkipVotes...)
	return cp
}

// Threshold table: n listeners, the need-th vote passes the track.
func TestVoteSkip_ThresholdByListeners(t *testing.T) {
	for n := 1; n <= 5; n++ {
		t.Run(fmt.Sprintf("n=%d", n), func(t *testing.T) {
			users := map[string]string{}
			for i := 0; i < n; i++ {
				users[fmt.Sprintf("c%d", i)] = fmt.Sprintf("u%d", i)
			}
			roomID := fmt.Sprintf("SKIPT%d", n)
			h, first := skipRoom(t, roomID, 2, users)
			need := queue.SkipVotesNeeded(n)
			for i := 0; i < need; i++ {
				if snap := roomSnapshot(t, h, roomID); snap.NowPlayingID != first {
					t.Fatalf("advanced after only %d of %d votes", i, need)
				}
				if _, err := skipVote(h, fmt.Sprintf("c%d", i), fmt.Sprintf("u%d", i), roomID, first); err != nil {
					t.Fatalf("vote %d: %v", i, err)
				}
			}
			snap := roomSnapshot(t, h, roomID)
			if snap.NowPlayingID == first {
				t.Fatalf("still on the first track after %d votes", need)
			}
			if len(snap.SkipVotes) != 0 {
				t.Fatalf("votes not reset on track change: %v", snap.SkipVotes)
			}
		})
	}
}

func TestVoteSkip_ToggleOnOff(t *testing.T) {
	h, first := skipRoom(t, "SKIPTOG", 2, map[string]string{"c0": "u0", "c1": "u1", "c2": "u2"})
	st, err := skipVote(h, "c0", "u0", "SKIPTOG", first)
	if err != nil || len(st.SkipVotes) != 1 {
		t.Fatalf("on: %v %v", err, st.SkipVotes)
	}
	st, err = skipVote(h, "c0", "u0", "SKIPTOG", first)
	if err != nil || len(st.SkipVotes) != 0 {
		t.Fatalf("off: %v %v", err, st.SkipVotes)
	}
	// Explicit values are idempotent.
	for i := 0; i < 2; i++ {
		res, err := h.serveRPC(newTestClient("c0", "u0"), "now_playing.vote_skip",
			[]byte(fmt.Sprintf(`{"roomId":"SKIPTOG","nowPlayingId":"%s","vote":true}`, first)))
		if err != nil {
			t.Fatal(err)
		}
		_ = json.Unmarshal(res, &st)
		if len(st.SkipVotes) != 1 {
			t.Fatalf("explicit vote:true round %d: %v", i, st.SkipVotes)
		}
	}
}

func TestVoteSkip_TwoTabsOfOneUserCountOnce(t *testing.T) {
	// u0 has two tabs and u1 one: 2 distinct listeners, need 2.
	h, first := skipRoom(t, "SKIPTABS", 2, map[string]string{"c0a": "u0", "c0b": "u0", "c1": "u1"})
	if _, err := skipVote(h, "c0a", "u0", "SKIPTABS", first); err != nil {
		t.Fatal(err)
	}
	// The same user from the other tab is the same voter: off, then on again.
	for i := 0; i < 2; i++ {
		if _, err := skipVote(h, "c0b", "u0", "SKIPTABS", first); err != nil {
			t.Fatal(err)
		}
	}
	if snap := roomSnapshot(t, h, "SKIPTABS"); snap.NowPlayingID != first || len(snap.SkipVotes) != 1 {
		t.Fatalf("two tabs must be one vote: playing=%s votes=%v", snap.NowPlayingID, snap.SkipVotes)
	}
	if _, err := skipVote(h, "c1", "u1", "SKIPTABS", first); err != nil {
		t.Fatal(err)
	}
	if snap := roomSnapshot(t, h, "SKIPTABS"); snap.NowPlayingID == first {
		t.Fatal("second distinct listener should pass the track")
	}
}

func TestVoteSkip_ResetsOnHostAdvance(t *testing.T) {
	h, first := skipRoom(t, "SKIPRST", 3, map[string]string{"c0": "u0", "c1": "u1", "c2": "u2"})
	if _, err := skipVote(h, "c0", "u0", "SKIPRST", first); err != nil {
		t.Fatal(err)
	}
	if _, err := h.HandleRPC("now_playing.advance", []byte(fmt.Sprintf(`{"roomId":"SKIPRST","afterId":"%s"}`, first)), ""); err != nil {
		t.Fatal(err)
	}
	if snap := roomSnapshot(t, h, "SKIPRST"); len(snap.SkipVotes) != 0 || snap.NowPlayingID == first {
		t.Fatalf("host skip must reset votes: %+v", snap.SkipVotes)
	}
}

func TestVoteSkip_LeavePrunesAbsentVoter(t *testing.T) {
	// 3 listeners (need 2). u0 votes; a non-voter leaves (n=2, need 2: stays).
	h, first := skipRoom(t, "SKIPLV", 2, map[string]string{"c0": "u0", "c1": "u1", "c2": "u2"})
	if _, err := skipVote(h, "c0", "u0", "SKIPLV", first); err != nil {
		t.Fatal(err)
	}
	h.Leave("c1")
	if snap := roomSnapshot(t, h, "SKIPLV"); snap.NowPlayingID != first || len(snap.SkipVotes) != 1 {
		t.Fatalf("n=2 with 1 vote must stay: %+v", snap)
	}
	// The voter leaves: their vote stops counting.
	h.Leave("c0")
	if snap := roomSnapshot(t, h, "SKIPLV"); len(snap.SkipVotes) != 0 {
		t.Fatalf("absent voter's vote must be pruned: %v", snap.SkipVotes)
	}
}

func TestVoteSkip_LeaveReachingThresholdAdvances(t *testing.T) {
	// 5 listeners need 3. Two vote (not enough). One non-voter leaves: n=4
	// needs 2, and the standing 2 votes now pass the track.
	users := map[string]string{"c0": "u0", "c1": "u1", "c2": "u2", "c3": "u3", "c4": "u4"}
	h, first := skipRoom(t, "SKIPLV2", 2, users)
	for _, i := range []string{"0", "1"} {
		if _, err := skipVote(h, "c"+i, "u"+i, "SKIPLV2", first); err != nil {
			t.Fatal(err)
		}
	}
	if snap := roomSnapshot(t, h, "SKIPLV2"); snap.NowPlayingID != first {
		t.Fatal("2 of 5 must not pass")
	}
	h.Leave("c3")
	snap := roomSnapshot(t, h, "SKIPLV2")
	if snap.NowPlayingID == first {
		t.Fatal("a leave that makes 2 of 4 must advance")
	}
	if len(snap.SkipVotes) != 0 {
		t.Fatalf("votes must reset after the advance: %v", snap.SkipVotes)
	}
}

func TestVoteSkip_StaleIDRejected(t *testing.T) {
	h, first := skipRoom(t, "SKIPSTALE", 2, map[string]string{"c0": "u0", "c1": "u1"})
	_, err := skipVote(h, "c0", "u0", "SKIPSTALE", "not-the-playing-track")
	var ue *UserError
	if !errors.As(err, &ue) {
		t.Fatalf("stale id: got %T %v, want *UserError", err, err)
	}
	if snap := roomSnapshot(t, h, "SKIPSTALE"); len(snap.SkipVotes) != 0 || snap.NowPlayingID != first {
		t.Fatal("stale vote must not change state")
	}
}

func TestVoteSkip_NonMemberRejected(t *testing.T) {
	h, first := skipRoom(t, "SKIPNM", 2, map[string]string{"c0": "u0"})
	_, err := skipVote(h, "intruder", "", "SKIPNM", first)
	if !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("non-member: got %v, want ErrorPermissionDenied", err)
	}
	// The transport-independent path re-checks membership too.
	if _, err := h.handleRPC("now_playing.vote_skip", skipPayload("SKIPNM", first), "intruder", ""); err == nil {
		t.Fatal("handleRPC by a non-member must fail")
	}
}

func TestVoteSkip_RateLimited(t *testing.T) {
	h, first := skipRoom(t, "SKIPRL", 2, map[string]string{"c0": "u0", "c1": "u1", "c2": "u2"})
	clock := &fakeClock{now: time.Now()}
	h.voteLimiter = newRateLimiter(2, time.Hour, clock.Now)
	for i := 0; i < 2; i++ {
		if _, err := skipVote(h, "c0", "u0", "SKIPRL", first); err != nil {
			t.Fatalf("within burst %d: %v", i, err)
		}
	}
	_, err := skipVote(h, "c0", "u0", "SKIPRL", first)
	var ue *UserError
	if !errors.As(err, &ue) {
		t.Fatalf("past burst: got %T %v, want *UserError", err, err)
	}
}

func TestVoteSkip_FlagOffMethodNotFound(t *testing.T) {
	h := NewHub(nil) // voting off
	h.Join("c0", "SKIPOFF")
	_, err := h.serveRPC(newTestClient("c0", ""), "now_playing.vote_skip", skipPayload("SKIPOFF", "x"))
	if !errors.Is(err, centrifuge.ErrorMethodNotFound) {
		t.Fatalf("flag off: got %v, want ErrorMethodNotFound", err)
	}
}

func TestVoteSkip_RebindRewritesVoter(t *testing.T) {
	s := &queue.RoomState{SkipVotes: []string{"user:old", "user:other"}}
	s.RewriteSkipVoter("user:old", "user:new")
	if len(s.SkipVotes) != 2 || s.SkipVotes[0] != "user:new" {
		t.Fatalf("rewrite: %v", s.SkipVotes)
	}
	s.SkipVotes = []string{"user:old", "user:new"}
	s.RewriteSkipVoter("user:old", "user:new")
	if len(s.SkipVotes) != 1 || s.SkipVotes[0] != "user:new" {
		t.Fatalf("rewrite dedupe: %v", s.SkipVotes)
	}
}

// A connection blip (leave then rejoin inside the grace period) must not make
// one standing vote pass the track for a room that did not change.
func TestVoteSkip_BlipWithinGrace(t *testing.T) {
	h, first := skipRoom(t, "SKIPBLIP", 2, map[string]string{"c0": "u0", "c1": "u1"})
	h.skipGrace = 80 * time.Millisecond
	if _, err := skipVote(h, "c0", "u0", "SKIPBLIP", first); err != nil {
		t.Fatal(err)
	}
	h.Leave("c1")
	h.Join("c1", "SKIPBLIP")
	time.Sleep(250 * time.Millisecond)
	snap := roomSnapshot(t, h, "SKIPBLIP")
	if snap.NowPlayingID != first || len(snap.SkipVotes) != 1 {
		t.Fatalf("a blip must not advance or drop votes: %+v", snap)
	}
	// A real departure still counts once the grace passes.
	h.Leave("c1")
	time.Sleep(250 * time.Millisecond)
	if snap := roomSnapshot(t, h, "SKIPBLIP"); snap.NowPlayingID == first {
		t.Fatal("after the grace, the lone listener's vote must pass the track")
	}
}
