package queue

import (
	"testing"
)

func TestAdd(t *testing.T) {
	rs := &RoomState{
		RoomID: "room1",
		Queue:  []TrackRef{},
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
		RoomID: "room1",
		Queue:  []TrackRef{},
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
		Version: 1,
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
		Version: 1,
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
