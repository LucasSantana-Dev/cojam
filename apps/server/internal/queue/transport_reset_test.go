package queue

import "testing"

func stale() *TransportState {
	return &TransportState{State: "playing", PositionMs: 90_000, UpdatedAtServerMs: 1}
}

func assertReset(t *testing.T, rs *RoomState, wantState string) {
	t.Helper()
	if rs.Transport.State != wantState || rs.Transport.PositionMs != 0 || rs.Transport.UpdatedAtServerMs <= 1 {
		t.Fatalf("transport not re-anchored: %+v", rs.Transport)
	}
}

func twoTracks() *RoomState {
	rs := &RoomState{RoomID: "r"}
	rs.Add(TrackRef{Title: "a"})
	rs.Add(TrackRef{Title: "b"})
	rs.Transport = stale()
	return rs
}

func TestTransportResetOnSetNowPlaying(t *testing.T) {
	rs := twoTracks()
	if err := rs.SetNowPlaying(rs.Queue[1].ID); err != nil {
		t.Fatal(err)
	}
	assertReset(t, rs, "playing")
}

func TestTransportResetOnAdvance(t *testing.T) {
	rs := twoTracks()
	_ = rs.AdvanceAfter(rs.Queue[0].ID)
	assertReset(t, rs, "playing")
	rs.Transport = stale()
	_ = rs.AdvanceAfter(rs.Queue[0].ID) // last: clears
	assertReset(t, rs, "playing")
}

func TestTransportResetOnAddToEmpty(t *testing.T) {
	rs := &RoomState{RoomID: "r", Transport: &TransportState{State: "paused", PositionMs: 5000, UpdatedAtServerMs: 1}}
	rs.Add(TrackRef{Title: "a"})
	assertReset(t, rs, "paused")
}

func TestTransportResetOnRadioRefillToEmpty(t *testing.T) {
	rs := twoTracks()
	_ = rs.AdvanceAfter(rs.Queue[0].ID)
	_ = rs.AdvanceAfter(rs.Queue[0].ID) // empty
	rs.Transport = stale()
	rs.Add(TrackRef{Title: "radio"}) // what the refill does
	assertReset(t, rs, "playing")
}

func TestTransportResetOnRemoveOfCurrent(t *testing.T) {
	rs := twoTracks()
	if err := rs.Remove(rs.Queue[0].ID); err != nil {
		t.Fatal(err)
	}
	assertReset(t, rs, "playing")
}

func TestTransportUntouchedWhenPointerStays(t *testing.T) {
	rs := twoTracks()
	_ = rs.AdvanceAfter("not-current")
	rs.Add(TrackRef{Title: "c"})
	if rs.Transport.PositionMs != 90_000 {
		t.Fatalf("transport changed: %+v", rs.Transport)
	}
}
