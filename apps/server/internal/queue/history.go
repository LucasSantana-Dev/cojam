package queue

import (
	"fmt"
	"time"
)

// MaxHistory caps RoomState.History. The state is published in full on every
// change, so the played list must stay bounded.
const MaxHistory = 50

// HistoryEntry is a track that finished or was skipped. The list-facing fields
// are id, title, artist, artworkUrl, playedAt and addedBy; the rest is kept
// only so a controller can re-add the track (history.readd) without trusting a
// client-supplied payload. History is separate from Queue so that votes and
// reorders (which only touch Queue) can never bring a played track back.
type HistoryEntry struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	Artist        string `json:"artist"`
	ArtworkURL    string `json:"artworkUrl,omitempty"`
	AddedBy       string `json:"addedBy"`
	AddedByUserID string `json:"addedByUserId,omitempty"`
	// PlayedAt is the server clock (unix ms) when the track left now-playing.
	// Zero on entries migrated from the pre-history shape.
	PlayedAt   int64   `json:"playedAt,omitempty"`
	DurationMs int64   `json:"durationMs,omitempty"`
	ISRC       string  `json:"isrc,omitempty"`
	Kind       string  `json:"kind,omitempty"`
	Sources    Sources `json:"sources"`
}

func historyFromTrack(t TrackRef, playedAt int64) HistoryEntry {
	return HistoryEntry{
		ID: t.ID, Title: t.Title, Artist: t.Artist, ArtworkURL: t.ArtworkURL,
		AddedBy: t.AddedBy, AddedByUserID: t.AddedByUserID, PlayedAt: playedAt,
		DurationMs: t.DurationMs, ISRC: t.ISRC, Kind: t.Kind, Sources: t.Sources,
	}
}

// pushHistory prepends t (newest first) and trims to MaxHistory. Votes on the
// track go with it: a played track has no vote count.
func (rs *RoomState) pushHistory(t TrackRef, playedAt int64) {
	delete(rs.Votes, t.ID)
	rs.History = append([]HistoryEntry{historyFromTrack(t, playedAt)}, rs.History...)
	if len(rs.History) > MaxHistory {
		rs.History = rs.History[:MaxHistory]
	}
}

// retireNowPlaying moves the outgoing now-playing track from Queue to History.
// A no-op when nothing is playing or the pointer is dangling. Every path that
// changes now-playing calls it, so Queue holds only the playing track (at the
// head) plus upcoming ones.
func (rs *RoomState) retireNowPlaying() {
	if rs.NowPlayingID == "" {
		return
	}
	for i, t := range rs.Queue {
		if t.ID == rs.NowPlayingID {
			rs.Queue = append(rs.Queue[:i], rs.Queue[i+1:]...)
			rs.pushHistory(t, time.Now().UnixMilli())
			return
		}
	}
}

// moveToFront keeps the invariant that the playing track is Queue[0].
func (rs *RoomState) moveToFront(id string) {
	for i, t := range rs.Queue {
		if t.ID == id {
			if i > 0 {
				copy(rs.Queue[1:i+1], rs.Queue[:i])
				rs.Queue[0] = t
			}
			return
		}
	}
}

// ErrHistoryNotFound is returned by ReAddFromHistory for an unknown entry.
var ErrHistoryNotFound = fmt.Errorf("%w: history entry", ErrTrackNotFound)

// ReAddFromHistory appends a copy of a played track to the end of the queue as
// a new entry with a new id (and the new adder's attribution). The history
// entry is left in place and the old queue id is never resurrected.
func (rs *RoomState) ReAddFromHistory(historyID, addedBy, addedByUserID string) (*TrackRef, error) {
	for _, h := range rs.History {
		if h.ID != historyID {
			continue
		}
		t := TrackRef{
			Title: h.Title, Artist: h.Artist, ArtworkURL: h.ArtworkURL,
			DurationMs: h.DurationMs, ISRC: h.ISRC, Kind: h.Kind, Sources: h.Sources,
			AddedBy: addedBy, AddedByUserID: addedByUserID,
		}
		if t.AddedBy == "" {
			t.AddedBy = h.AddedBy
		}
		return rs.Add(t), nil
	}
	return nil, fmt.Errorf("%w: %s", ErrHistoryNotFound, historyID)
}

// MigrateLegacy converts the pre-history shape, where played tracks stayed in
// Queue behind the now-playing pointer, to the current one: every track before
// the now-playing index (all of them when nothing is playing) moves to History
// in played order, newest first. Idempotent: the current shape has the playing
// track at index 0, so a second run changes nothing. Reports whether it moved
// anything.
func (rs *RoomState) MigrateLegacy() bool {
	idx := len(rs.Queue)
	if rs.NowPlayingID != "" {
		idx = -1
		for i, t := range rs.Queue {
			if t.ID == rs.NowPlayingID {
				idx = i
				break
			}
		}
		if idx < 0 {
			return false // dangling pointer: leave the queue alone
		}
	}
	if idx == 0 {
		return false
	}
	played := rs.Queue[:idx]
	migrated := make([]HistoryEntry, 0, len(played)+len(rs.History))
	for i := len(played) - 1; i >= 0; i-- {
		delete(rs.Votes, played[i].ID)
		migrated = append(migrated, historyFromTrack(played[i], 0))
	}
	migrated = append(migrated, rs.History...)
	if len(migrated) > MaxHistory {
		migrated = migrated[:MaxHistory]
	}
	rs.History = migrated
	rs.Queue = append([]TrackRef{}, rs.Queue[idx:]...)
	return true
}

// nextUpcoming returns the id of the head of the queue once the playing track
// has been retired, or "" when the queue is empty.
func (rs *RoomState) nextUpcoming() string {
	if len(rs.Queue) == 0 {
		return ""
	}
	return rs.Queue[0].ID
}

// switchTo points now-playing at id and keeps it at the head of Queue.
func (rs *RoomState) switchTo(id string) {
	rs.setNowPlayingID(id)
	if id != "" {
		rs.moveToFront(id)
	}
}
