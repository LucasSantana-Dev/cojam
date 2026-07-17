package queue

import (
	"testing"
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
