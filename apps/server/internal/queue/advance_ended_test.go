package queue

import "testing"

func playingAt(pos, updated int64) *RoomState {
	rs := &RoomState{RoomID: "r"}
	rs.Add(TrackRef{Title: "a", DurationMs: 223_000})
	rs.Add(TrackRef{Title: "b", DurationMs: 100_000})
	rs.Transport = &TransportState{State: "playing", PositionMs: pos, UpdatedAtServerMs: updated}
	return rs
}

func TestAdvanceIfEndedStaleTransport(t *testing.T) {
	rs := playingAt(0, 1_000)
	second := rs.Queue[1].ID
	v := rs.Version
	if !rs.AdvanceIfEnded(1_000 + 62*60*1000) {
		t.Fatal("62 minutes into a 3:43 track must advance")
	}
	if rs.NowPlayingID != second {
		t.Fatalf("now playing = %q, want the next track %q", rs.NowPlayingID, second)
	}
	if rs.Version != v+1 {
		t.Fatalf("version = %d, want %d", rs.Version, v+1)
	}
	if rs.Transport.PositionMs != 0 || rs.Transport.UpdatedAtServerMs <= 1_000 {
		t.Fatalf("transport not re-anchored: %+v", rs.Transport)
	}
	// One step only: the new track is fresh, so a second call is a no-op.
	if rs.AdvanceIfEnded(rs.Transport.UpdatedAtServerMs + 1) {
		t.Fatal("must not skip the whole queue")
	}
}

func TestAdvanceIfEndedLeavesLiveAndUnknownAlone(t *testing.T) {
	rs := playingAt(0, 1_000)
	if rs.AdvanceIfEnded(1_000 + 223_000) { // at the end, inside the grace
		t.Fatal("inside the grace window must not advance")
	}
	rs = playingAt(0, 1_000)
	rs.Transport.State = "paused"
	if rs.AdvanceIfEnded(1_000 + 3_600_000) {
		t.Fatal("paused transport never ends")
	}
	rs = playingAt(0, 1_000)
	rs.Queue[0].DurationMs = 0
	if rs.AdvanceIfEnded(1_000 + 3_600_000) {
		t.Fatal("unknown duration must be left alone")
	}
	rs = playingAt(0, 1_000)
	rs.Transport = nil
	if rs.AdvanceIfEnded(1_000 + 3_600_000) {
		t.Fatal("no transport, nothing to advance")
	}
}

func TestAdvanceIfEndedLastTrackClears(t *testing.T) {
	rs := playingAt(0, 1_000)
	rs.NowPlayingID = rs.Queue[1].ID
	if !rs.AdvanceIfEnded(1_000 + 3_600_000) {
		t.Fatal("last track past its end must advance")
	}
	if rs.NowPlayingID != "" {
		t.Fatalf("now playing = %q, want cleared", rs.NowPlayingID)
	}
}
