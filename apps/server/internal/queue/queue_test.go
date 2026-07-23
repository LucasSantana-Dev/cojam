package queue

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestAdd(t *testing.T) {
	rs := &RoomState{
		RoomID:  "room1",
		Queue:   []TrackRef{},
		Version: 0,
	}

	track := TrackRef{
		Title:   "Song A",
		Artist:  "Artist A",
		AddedBy: "user1",
		Sources: Sources{},
	}

	added := rs.Add(track)

	if added.ID == "" {
		t.Error("expected ID to be generated")
	}
	if rs.Version != 1 {
		t.Errorf("expected version 1, got %d", rs.Version)
	}
	if rs.NowPlayingID != added.ID {
		t.Errorf("expected NowPlayingID to be set to %s, got %s", added.ID, rs.NowPlayingID)
	}
	if len(rs.Queue) != 1 {
		t.Errorf("expected queue length 1, got %d", len(rs.Queue))
	}
}

func TestAddMultipleTracks(t *testing.T) {
	rs := &RoomState{
		RoomID:  "room1",
		Queue:   []TrackRef{},
		Version: 0,
	}

	track1 := TrackRef{Title: "Song 1", Artist: "A1", AddedBy: "user1", Sources: Sources{}}
	track2 := TrackRef{Title: "Song 2", Artist: "A2", AddedBy: "user2", Sources: Sources{}}

	id1 := rs.Add(track1).ID
	_ = rs.Add(track2).ID

	if rs.Version != 2 {
		t.Errorf("expected version 2, got %d", rs.Version)
	}
	if rs.NowPlayingID != id1 {
		t.Errorf("expected NowPlayingID to remain %s, got %s", id1, rs.NowPlayingID)
	}
	if len(rs.Queue) != 2 {
		t.Errorf("expected queue length 2, got %d", len(rs.Queue))
	}
}

func TestRemove(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
			{ID: "t2", Title: "Song 2", AddedBy: "u2", Sources: Sources{}},
		},
		NowPlayingID: "t1",
		Version:      1,
	}

	err := rs.Remove("t1")
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if rs.Version != 2 {
		t.Errorf("expected version 2, got %d", rs.Version)
	}
	if rs.NowPlayingID != "" {
		t.Errorf("expected NowPlayingID to be cleared, got %s", rs.NowPlayingID)
	}
	if len(rs.Queue) != 1 {
		t.Errorf("expected queue length 1, got %d", len(rs.Queue))
	}
}

func TestRemoveNotFound(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
		},
		Version: 1,
	}

	err := rs.Remove("nonexistent")
	if err == nil {
		t.Error("expected error for nonexistent track")
	}
}

func TestSetNowPlaying(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
			{ID: "t2", Title: "Song 2", AddedBy: "u2", Sources: Sources{}},
		},
		NowPlayingID: "t1",
		Version:      1,
	}

	err := rs.SetNowPlaying("t2")
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if rs.NowPlayingID != "t2" {
		t.Errorf("expected NowPlayingID to be t2, got %s", rs.NowPlayingID)
	}
	if rs.Version != 2 {
		t.Errorf("expected version 2, got %d", rs.Version)
	}
}

func TestSetNowPlayingNotFound(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
		},
		Version: 1,
	}

	err := rs.SetNowPlaying("nonexistent")
	if err == nil {
		t.Error("expected error for nonexistent track")
	}
}

func TestAdvanceAfter(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
			{ID: "t2", Title: "Song 2", AddedBy: "u2", Sources: Sources{}},
			{ID: "t3", Title: "Song 3", AddedBy: "u3", Sources: Sources{}},
		},
		NowPlayingID: "t1",
		Version:      1,
	}

	err := rs.AdvanceAfter("t1")
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if rs.NowPlayingID != "t2" {
		t.Errorf("expected NowPlayingID to be t2, got %s", rs.NowPlayingID)
	}
	if rs.Version != 2 {
		t.Errorf("expected version 2, got %d", rs.Version)
	}
}

func TestAdvanceAfterToLastTrack(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
			{ID: "t2", Title: "Song 2", AddedBy: "u2", Sources: Sources{}},
		},
		NowPlayingID: "t2",
		Version:      1,
	}

	err := rs.AdvanceAfter("t2")
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if rs.NowPlayingID != "" {
		t.Errorf("expected NowPlayingID to be cleared, got %s", rs.NowPlayingID)
	}
	if rs.Version != 2 {
		t.Errorf("expected version 2, got %d", rs.Version)
	}
}

func TestAdvanceAfterIdempotent(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
			{ID: "t2", Title: "Song 2", AddedBy: "u2", Sources: Sources{}},
		},
		NowPlayingID: "t2",
		Version:      1,
	}

	// Call with stale afterID (NowPlayingID has already moved to t2)
	err := rs.AdvanceAfter("t1")
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	// Should be a no-op: NowPlayingID stays t2, Version unchanged
	if rs.NowPlayingID != "t2" {
		t.Errorf("expected NowPlayingID to remain t2, got %s", rs.NowPlayingID)
	}
	if rs.Version != 1 {
		t.Errorf("expected version to remain 1 (no-op), got %d", rs.Version)
	}
}

func TestMove(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
			{ID: "t2", Title: "Song 2", AddedBy: "u2", Sources: Sources{}},
			{ID: "t3", Title: "Song 3", AddedBy: "u3", Sources: Sources{}},
		},
		NowPlayingID: "t1",
		Version:      1,
	}

	err := rs.Move("t3", 0)
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if rs.Queue[0].ID != "t3" {
		t.Errorf("expected t3 at index 0, got %s", rs.Queue[0].ID)
	}
	if rs.Queue[1].ID != "t1" {
		t.Errorf("expected t1 at index 1, got %s", rs.Queue[1].ID)
	}
	if rs.Queue[2].ID != "t2" {
		t.Errorf("expected t2 at index 2, got %s", rs.Queue[2].ID)
	}
	if rs.Version != 2 {
		t.Errorf("expected version 2, got %d", rs.Version)
	}
	// NowPlayingID should not change
	if rs.NowPlayingID != "t1" {
		t.Errorf("expected NowPlayingID to remain t1, got %s", rs.NowPlayingID)
	}
}

func TestMoveClampsToEnd(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
			{ID: "t2", Title: "Song 2", AddedBy: "u2", Sources: Sources{}},
		},
		NowPlayingID: "t1",
		Version:      1,
	}

	err := rs.Move("t1", 999)
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if rs.Queue[1].ID != "t1" {
		t.Errorf("expected t1 at end (index 1), got %s", rs.Queue[1].ID)
	}
}

func TestMoveClampsToStart(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
			{ID: "t2", Title: "Song 2", AddedBy: "u2", Sources: Sources{}},
		},
		NowPlayingID: "t2",
		Version:      1,
	}

	err := rs.Move("t2", -1)
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if rs.Queue[0].ID != "t2" {
		t.Errorf("expected t2 at start (index 0), got %s", rs.Queue[0].ID)
	}
}

func TestMoveNotFound(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
		},
		Version: 1,
	}

	err := rs.Move("nonexistent", 0)
	if err == nil {
		t.Error("expected error for nonexistent track")
	}
}

func TestAdvanceAfterSequence(t *testing.T) {
	// Replicate the exact sequence from the hub test
	rs := &RoomState{
		RoomID:  "room1",
		Queue:   []TrackRef{},
		Version: 0,
	}

	// Add 3 tracks
	track1 := TrackRef{Title: "Song 1", Artist: "A1", AddedBy: "u1", Sources: Sources{}}
	track2 := TrackRef{Title: "Song 2", Artist: "A2", AddedBy: "u2", Sources: Sources{}}
	track3 := TrackRef{Title: "Song 3", Artist: "A3", AddedBy: "u3", Sources: Sources{}}

	t1 := rs.Add(track1)
	t2 := rs.Add(track2)
	t3 := rs.Add(track3)

	t.Logf("Initial: NowPlayingID=%s, t1=%s, t2=%s, t3=%s, queue len=%d", rs.NowPlayingID, t1.ID, t2.ID, t3.ID, len(rs.Queue))

	// Advance t1 -> t2
	err := rs.AdvanceAfter(t1.ID)
	if err != nil {
		t.Errorf("advance 1 failed: %v", err)
	}
	if rs.NowPlayingID != t2.ID {
		t.Errorf("after advance 1: expected %s, got %s", t2.ID, rs.NowPlayingID)
	}
	t.Logf("After 1st: NowPlayingID=%s", rs.NowPlayingID)

	// Advance t2 -> t3
	err = rs.AdvanceAfter(t2.ID)
	if err != nil {
		t.Errorf("advance 2 failed: %v", err)
	}
	if rs.NowPlayingID != t3.ID {
		t.Errorf("after advance 2: expected %s, got %s", t3.ID, rs.NowPlayingID)
	}
	t.Logf("After 2nd: NowPlayingID=%s", rs.NowPlayingID)

	// Advance t3 (last) -> ""
	err = rs.AdvanceAfter(t3.ID)
	if err != nil {
		t.Errorf("advance 3 failed: %v", err)
	}
	if rs.NowPlayingID != "" {
		t.Errorf("after advance 3: expected empty, got %s", rs.NowPlayingID)
	}
	t.Logf("After 3rd: NowPlayingID=%q", rs.NowPlayingID)
}

func TestAdd_StampsAddedAt(t *testing.T) {
	rs := &RoomState{
		RoomID:  "room1",
		Queue:   []TrackRef{},
		Version: 0,
	}

	// A client-supplied AddedAt must be overwritten with the server clock.
	before := time.Now().UnixMilli()
	added := rs.Add(TrackRef{Title: "Song", Artist: "A", AddedBy: "u", Sources: Sources{}, AddedAt: 1})
	after := time.Now().UnixMilli()

	if added.AddedAt < before || added.AddedAt > after {
		t.Errorf("expected AddedAt within [%d, %d], got %d", before, after, added.AddedAt)
	}
}

// Rooms and tracks persisted before timestamps existed carry no addedAt /
// createdAt; they must still load (zero value tolerated).
func TestRoomState_LegacyJSONWithoutTimestamps(t *testing.T) {
	legacy := `{"roomId":"r","queue":[{"id":"t1","title":"T","artist":"A","sources":{},"addedBy":"u"}],"radioEnabled":false,"version":3}`

	var rs RoomState
	if err := json.Unmarshal([]byte(legacy), &rs); err != nil {
		t.Fatalf("legacy state must unmarshal: %v", err)
	}
	if rs.CreatedAt != 0 {
		t.Errorf("expected zero CreatedAt on legacy room, got %d", rs.CreatedAt)
	}
	if len(rs.Queue) != 1 || rs.Queue[0].AddedAt != 0 {
		t.Errorf("expected zero AddedAt on legacy track, got %+v", rs.Queue)
	}
}

func TestToggleVote(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
		},
		Version: 1,
	}

	voted, err := rs.ToggleVote("t1", "user:alice")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !voted {
		t.Error("expected voted=true on first toggle")
	}
	if rs.Version != 2 {
		t.Errorf("expected version 2, got %d", rs.Version)
	}
	voters := rs.Votes["t1"]
	if len(voters) != 1 || voters[0] != "user:alice" {
		t.Errorf("expected votes[t1] = [user:alice], got %v", voters)
	}
}

func TestToggleVoteSecondCallRemoves(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
		},
		Version: 1,
	}

	if _, err := rs.ToggleVote("t1", "user:alice"); err != nil {
		t.Fatalf("first toggle: %v", err)
	}
	voted, err := rs.ToggleVote("t1", "user:alice")
	if err != nil {
		t.Fatalf("second toggle: %v", err)
	}
	if voted {
		t.Error("expected voted=false on second toggle (vote off)")
	}
	if rs.Version != 3 {
		t.Errorf("expected version 3, got %d", rs.Version)
	}
	if _, ok := rs.Votes["t1"]; ok {
		t.Errorf("expected votes[t1] entry pruned at zero voters, got %v", rs.Votes["t1"])
	}
}

func TestToggleVoteNotFound(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
		},
		Version: 1,
	}

	_, err := rs.ToggleVote("nonexistent", "user:alice")
	if !errors.Is(err, ErrTrackNotFound) {
		t.Errorf("expected ErrTrackNotFound, got %v", err)
	}
	if rs.Version != 1 {
		t.Errorf("expected version unchanged at 1, got %d", rs.Version)
	}
}

func TestToggleVoteCap(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
		},
		Version: 0,
	}

	for i := 0; i < MaxVotersPerTrack; i++ {
		if _, err := rs.ToggleVote("t1", fmt.Sprintf("user:%d", i)); err != nil {
			t.Fatalf("vote %d within cap: %v", i, err)
		}
	}

	if _, err := rs.ToggleVote("t1", "user:overflow"); !errors.Is(err, ErrVoteCapReached) {
		t.Fatalf("expected ErrVoteCapReached past the cap, got %v", err)
	}

	// Toggling an existing vote OFF must still work at the cap.
	voted, err := rs.ToggleVote("t1", "user:0")
	if err != nil {
		t.Fatalf("unvote at cap: %v", err)
	}
	if voted {
		t.Error("expected voted=false when unvoting at cap")
	}
}

func TestToggleVoteVersionOnlyOnChange(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
		},
		Version: 1,
	}

	// Unknown track: no change, no bump.
	if _, err := rs.ToggleVote("nope", "user:alice"); err == nil {
		t.Fatal("expected error for unknown track")
	}
	if rs.Version != 1 {
		t.Errorf("no-op toggle bumped version: got %d, want 1", rs.Version)
	}

	// Distinct voters each bump once.
	if _, err := rs.ToggleVote("t1", "user:alice"); err != nil {
		t.Fatalf("alice vote: %v", err)
	}
	if _, err := rs.ToggleVote("t1", "user:bob"); err != nil {
		t.Fatalf("bob vote: %v", err)
	}
	if rs.Version != 3 {
		t.Errorf("expected version 3 after two votes, got %d", rs.Version)
	}
	if got := len(rs.Votes["t1"]); got != 2 {
		t.Errorf("expected 2 distinct voters, got %d", got)
	}
}

func TestRemovePrunesVotes(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue: []TrackRef{
			{ID: "t1", Title: "Song 1", AddedBy: "u1", Sources: Sources{}},
			{ID: "t2", Title: "Song 2", AddedBy: "u2", Sources: Sources{}},
		},
		Version: 1,
	}

	if _, err := rs.ToggleVote("t1", "user:alice"); err != nil {
		t.Fatalf("vote t1: %v", err)
	}
	if _, err := rs.ToggleVote("t2", "user:bob"); err != nil {
		t.Fatalf("vote t2: %v", err)
	}

	if err := rs.Remove("t1"); err != nil {
		t.Fatalf("remove t1: %v", err)
	}
	if _, ok := rs.Votes["t1"]; ok {
		t.Errorf("expected votes for t1 pruned on remove, got %v", rs.Votes["t1"])
	}
	if got := len(rs.Votes["t2"]); got != 1 {
		t.Errorf("expected votes for t2 untouched, got %d voters", got)
	}
}
