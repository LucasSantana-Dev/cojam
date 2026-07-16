package queue

import (
	"fmt"

	"github.com/google/uuid"
)

// SourceRef represents a reference to a music source (YouTube or Apple Music)
type SourceRef struct {
	VideoID    string  `json:"videoId,omitempty"`
	SongID     string  `json:"songId,omitempty"`
	Confidence float64 `json:"confidence"`
}

// Sources represents available music sources for a track
type Sources struct {
	YouTube *SourceRef `json:"youtube,omitempty"`
	Apple   *SourceRef `json:"apple,omitempty"`
}

// TrackRef represents a track in the queue
type TrackRef struct {
	ID         string  `json:"id"`
	Title      string  `json:"title"`
	Artist     string  `json:"artist"`
	DurationMs int64   `json:"durationMs,omitempty"`
	ISRC       string  `json:"isrc,omitempty"`
	Sources    Sources `json:"sources"`
	AddedBy    string  `json:"addedBy"`
}

// RoomState represents the current state of a room's queue
type RoomState struct {
	RoomID       string     `json:"roomId"`
	Queue        []TrackRef `json:"queue"`
	NowPlayingID string     `json:"nowPlayingId,omitempty"`
	Version      int64      `json:"version"`
}

// Add appends a track to the queue, generates an ID, and bumps the version.
// If the queue is empty, sets the track as NowPlayingID.
func (rs *RoomState) Add(track TrackRef) *TrackRef {
	track.ID = uuid.New().String()
	rs.Queue = append(rs.Queue, track)
	rs.Version++

	if rs.NowPlayingID == "" && len(rs.Queue) > 0 {
		rs.NowPlayingID = rs.Queue[0].ID
	}

	return &rs.Queue[len(rs.Queue)-1]
}

// Remove removes a track from the queue by ID and bumps the version.
// If the removed track was NowPlayingID, clears it.
func (rs *RoomState) Remove(trackID string) error {
	for i, t := range rs.Queue {
		if t.ID == trackID {
			rs.Queue = append(rs.Queue[:i], rs.Queue[i+1:]...)
			rs.Version++

			if rs.NowPlayingID == trackID {
				rs.NowPlayingID = ""
			}
			return nil
		}
	}
	return fmt.Errorf("track not found: %s", trackID)
}

// SetNowPlaying sets the now playing track by ID.
// Returns an error if the track is not in the queue.
func (rs *RoomState) SetNowPlaying(trackID string) error {
	for _, t := range rs.Queue {
		if t.ID == trackID {
			rs.NowPlayingID = trackID
			rs.Version++
			return nil
		}
	}
	return fmt.Errorf("track not found: %s", trackID)
}

// SetYouTubeSource attaches a resolved YouTube source to a queued track
// (async match enrichment). Bumps Version so clients accept the publication.
func (rs *RoomState) SetYouTubeSource(trackID string, ref SourceRef) error {
	for i := range rs.Queue {
		if rs.Queue[i].ID == trackID {
			rs.Queue[i].Sources.YouTube = &ref
			rs.Version++
			return nil
		}
	}
	return fmt.Errorf("track not found: %s", trackID)
}
