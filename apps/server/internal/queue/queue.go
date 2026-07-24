package queue

import (
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// MaxQueueSize bounds a room's queue so a malicious client can't OOM the server
// by flooding queue.add. Enforced at the RPC boundary (hub) under the room lock.
const MaxQueueSize = 500

// MaxVotersPerTrack caps how many distinct voter keys one track may hold
// (queue.vote, F4). Rooms are small; this only stops abuse of the votes map,
// which is published in full on every state change.
const MaxVotersPerTrack = 200

// ErrTrackNotFound is returned by RoomState mutations when no queued track has
// the requested ID. Sentinel so the hub can map it to a client-visible 400.
var ErrTrackNotFound = errors.New("track not found")

// ErrVoteCapReached is returned by ToggleVote when the track already holds
// MaxVotersPerTrack distinct voters. Sentinel so the hub can map it to a
// client-visible 400.
var ErrVoteCapReached = errors.New("vote cap reached")

// SourceRef represents a reference to a music source (YouTube or Apple Music)
type SourceRef struct {
	VideoID    string  `json:"videoId,omitempty"`
	SongID     string  `json:"songId,omitempty"`
	TrackURI   string  `json:"trackUri,omitempty"`
	Confidence float64 `json:"confidence"`
}

// Sources represents available music sources for a track
type Sources struct {
	YouTube *SourceRef `json:"youtube,omitempty"`
	Apple   *SourceRef `json:"apple,omitempty"`
	Spotify *SourceRef `json:"spotify,omitempty"`
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
	// AddedByUserID is the authenticated userID of the client that queued the
	// track (empty when FEATURE_ROOM_AUTH is off). Populated by the server from
	// the connection identity on queue.add/playlist.import; a client-supplied
	// value is always overwritten. Drives the queue.remove owner check (B16).
	AddedByUserID string `json:"addedByUserId,omitempty"`
	// AddedAt is the server clock (unix ms) when the track entered the queue.
	// Stamped by RoomState.Add, which overwrites any client-supplied value
	// (same trust-boundary posture as AddedByUserID). Zero on tracks queued
	// before this existed; clients must tolerate that.
	AddedAt int64 `json:"addedAt,omitempty"`
	// ArtworkURL is the album/track art URL, client-supplied at add time from
	// the provider response (validated https + length in validateImportTracks).
	// Empty on manual adds and tracks queued before this existed.
	ArtworkURL string `json:"artworkUrl,omitempty"`
}

// TransportState represents playback transport state
type TransportState struct {
	State             string `json:"state"`
	PositionMs        int64  `json:"positionMs"`
	UpdatedAtServerMs int64  `json:"updatedAtServerMs"`
}

// RoomState represents the current state of a room's queue
type RoomState struct {
	RoomID       string          `json:"roomId"`
	Queue        []TrackRef      `json:"queue"`
	NowPlayingID string          `json:"nowPlayingId,omitempty"`
	HostUserID   string          `json:"hostUserId,omitempty"`
	RadioEnabled bool            `json:"radioEnabled"`
	Version      int64           `json:"version"`
	Transport    *TransportState `json:"transport,omitempty"`
	// CreatedAt is the server clock (unix ms) at room creation, stamped by the
	// hub when it first creates the room. Zero on rooms persisted before this
	// existed; clients must tolerate that.
	CreatedAt int64 `json:"createdAt,omitempty"`
	// Votes maps track ID to the voter keys that upvoted it (F4). A voter key
	// is server-stamped ("user:<userID>" or "client:<clientID>"), never
	// client-supplied. Kept off TrackRef so client-supplied tracks need no
	// extra scrubbing; pruned when a track leaves the queue.
	Votes map[string][]string `json:"votes,omitempty"`
	// Public is the host-set directory opt-in (FEATURE_PUBLIC_ROOMS). The zero
	// value is private, so rooms persisted before this field existed stay
	// private unless a host explicitly opts in via room.set_public.
	Public bool `json:"public,omitempty"`
	// Name is an optional host-set room label shown in the public directory.
	Name string `json:"name,omitempty"`
}

// Add appends a track to the queue, generates an ID, stamps the server-side
// AddedAt (overwriting any client-supplied value), and bumps the version.
// If the queue is empty, sets the track as NowPlayingID.
func (rs *RoomState) Add(track TrackRef) *TrackRef {
	track.ID = uuid.New().String()
	track.AddedAt = time.Now().UnixMilli()
	rs.Queue = append(rs.Queue, track)
	rs.Version++

	if rs.NowPlayingID == "" && len(rs.Queue) > 0 {
		rs.NowPlayingID = rs.Queue[0].ID
	}

	return &rs.Queue[len(rs.Queue)-1]
}

// Remove removes a track from the queue by ID and bumps the version.
// If the removed track was NowPlayingID, clears it. The track's votes go with
// it so counts never outlive the track (F4).
func (rs *RoomState) Remove(trackID string) error {
	for i, t := range rs.Queue {
		if t.ID == trackID {
			rs.Queue = append(rs.Queue[:i], rs.Queue[i+1:]...)
			delete(rs.Votes, trackID)
			rs.Version++

			if rs.NowPlayingID == trackID {
				rs.NowPlayingID = ""
			}
			return nil
		}
	}
	return fmt.Errorf("track not found: %s", trackID)
}

// ToggleVote flips voter's upvote on trackID (F4): absent appends (vote on),
// present removes (vote off). One vote per voter per track is structural (set
// semantics). Returns whether the vote is now on. Bumps Version only when the
// set actually changes; a no-change toggle would publish a state the
// version-guarded clients rightly drop.
func (rs *RoomState) ToggleVote(trackID, voter string) (bool, error) {
	for _, t := range rs.Queue {
		if t.ID != trackID {
			continue
		}
		voters := rs.Votes[trackID]
		for i, v := range voters {
			if v == voter {
				voters = append(voters[:i], voters[i+1:]...)
				if len(voters) == 0 {
					delete(rs.Votes, trackID)
				} else {
					rs.Votes[trackID] = voters
				}
				rs.Version++
				return false, nil
			}
		}
		if len(voters) >= MaxVotersPerTrack {
			return false, fmt.Errorf("%w: %s", ErrVoteCapReached, trackID)
		}
		if rs.Votes == nil {
			rs.Votes = make(map[string][]string)
		}
		rs.Votes[trackID] = append(voters, voter)
		rs.Version++
		return true, nil
	}
	return false, fmt.Errorf("%w: %s", ErrTrackNotFound, trackID)
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

// AdvanceAfter moves NowPlayingID to the next track after afterID.
// IDEMPOTENT: if NowPlayingID != afterID, it's a no-op (another client advanced).
// If afterID is the last track, sets NowPlayingID to empty (queue finished).
// Bumps Version only if state actually changes.
func (rs *RoomState) AdvanceAfter(afterID string) error {
	// Idempotent check: if NowPlayingID != afterID, no-op
	if rs.NowPlayingID != afterID {
		return nil
	}

	// Find the index of afterID
	var afterIndex int
	found := false
	for i, t := range rs.Queue {
		if t.ID == afterID {
			afterIndex = i
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("track not found: %s", afterID)
	}

	// If afterID is the last track, clear NowPlayingID
	if afterIndex == len(rs.Queue)-1 {
		rs.NowPlayingID = ""
		rs.Version++
		return nil
	}

	// Otherwise, advance to the next track
	rs.NowPlayingID = rs.Queue[afterIndex+1].ID
	rs.Version++
	return nil
}

// Move relocates a track to a new position in the queue.
// Index is clamped to [0, len-1]; NowPlayingID is unchanged.
// Bumps Version when the move happens.
func (rs *RoomState) Move(trackID string, toIndex int) error {
	// Find the track to move
	var currentIndex int
	found := false
	for i, t := range rs.Queue {
		if t.ID == trackID {
			currentIndex = i
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("track not found: %s", trackID)
	}

	// Clamp toIndex
	if toIndex < 0 {
		toIndex = 0
	} else if toIndex >= len(rs.Queue) {
		toIndex = len(rs.Queue) - 1
	}

	// If already at the target index, no-op
	if currentIndex == toIndex {
		return nil
	}

	// Remove the track from its current position
	track := rs.Queue[currentIndex]
	rs.Queue = append(rs.Queue[:currentIndex], rs.Queue[currentIndex+1:]...)

	// Insert it at the new position
	rs.Queue = append(rs.Queue[:toIndex], append([]TrackRef{track}, rs.Queue[toIndex:]...)...)

	rs.Version++
	return nil
}

// SetSpotifySource attaches a resolved Spotify source to a queued track
// (async match enrichment). Bumps Version so clients accept the publication.
func (rs *RoomState) SetSpotifySource(trackID string, ref SourceRef) error {
	for i := range rs.Queue {
		if rs.Queue[i].ID == trackID {
			rs.Queue[i].Sources.Spotify = &ref
			rs.Version++
			return nil
		}
	}
	return fmt.Errorf("track not found: %s", trackID)
}
