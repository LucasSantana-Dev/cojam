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
	if len(rs.History) != 1 || rs.History[0].Title != "a" || len(rs.Queue) != 1 {
		t.Fatalf("the finished track must be retired once: history=%v queue=%v", historyTitles(rs), queueTitles(rs))
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
	if rs.AdvanceIfEnded(1_000 + 223_000) { // at the end, inside the margin
		t.Fatal("inside the margin window must not advance")
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
	_ = rs.AdvanceAfter(rs.NowPlayingID) // head-first: "b" is now the only queued track
	rs.Transport = &TransportState{State: "playing", PositionMs: 0, UpdatedAtServerMs: 1_000}
	last := rs.NowPlayingID
	if !rs.AdvanceIfEnded(1_000 + 3_600_000) {
		t.Fatal("last track past its end must advance")
	}
	if rs.NowPlayingID != "" {
		t.Fatalf("now playing = %q, want cleared", rs.NowPlayingID)
	}
	// Each outgoing track is retired exactly once: a, then b.
	if len(rs.History) != 2 || rs.History[0].ID != last || len(rs.Queue) != 0 {
		t.Fatalf("history=%v queue=%v", historyTitles(rs), queueTitles(rs))
	}
}

// The catalogue duration of a YouTube-matched track is not the video's: a
// joiner arriving while a longer video is still playing must not skip it.
func TestAdvanceIfEndedWideMargin(t *testing.T) {
	const dur = 223_000 // 3:43, margin = max(120 s, 111.5 s) = 120 s
	if got := StaleEndMarginMs(dur); got != 120_000 {
		t.Fatalf("margin = %d, want 120000", got)
	}
	if got := StaleEndMarginMs(600_000); got != 300_000 {
		t.Fatalf("10 min track margin = %d, want 300000 (half)", got)
	}
	cases := []struct {
		name    string
		elapsed int64
		want    bool
	}{
		{"video 4:30 still playing", 270_000, false},
		{"1:59 past the end", dur + 119_000, false},
		{"just under the 2:00 margin", dur + 119_999, false},
		{"exactly at the margin", dur + 120_000, true},
		{"2:30 past the end", dur + 150_000, true},
	}
	for _, c := range cases {
		rs := playingAt(0, 1_000)
		if got := rs.AdvanceIfEnded(1_000 + c.elapsed); got != c.want {
			t.Errorf("%s: advanced = %v, want %v", c.name, got, c.want)
		}
	}
}
