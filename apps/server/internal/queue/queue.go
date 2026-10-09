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

// SourceRef represents a reference to a music source (YouTube or Spotify)
type SourceRef struct {
	VideoID    string  `json:"videoId,omitempty"`
	TrackURI   string  `json:"trackUri,omitempty"`
	Confidence float64 `json:"confidence"`
}

// Sources represents available music sources for a track
type Sources struct {
	YouTube *SourceRef `json:"youtube,omitempty"`
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
	// AddedBy is the adder's display name. Stamped by the server from the
	// connection's connect-time name on queue.add/playlist.import when one
	// was recorded (#165); only then is a client-supplied value overwritten.
	AddedBy string `json:"addedBy"`
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
	// Kind selects audio or video rendering (#258). Empty means audio, so
	// existing queues and older clients keep working unchanged.
	Kind string `json:"kind,omitempty"`

	// EnrichPending counts source lookups still in flight for this track and
	// EnrichUncertain records that one failed with an error (not a clean
	// miss). Server-only bookkeeping for the sourceless auto skip: never
	// serialized, so never persisted or published (see roles.go).
	EnrichPending   int  `json:"-"`
	EnrichUncertain bool `json:"-"`
	// EnrichChecked is true once a lookup ran in this process and cleanly
	// missed (or no matcher exists at all). Unknown after a restart.
	EnrichChecked bool `json:"-"`
	// YTLookup is true once a YouTube lookup was launched for this track in
	// this process (in flight or finished): the dedupe flag of the lazy
	// matching window. YTQuota marks a track whose lookup is owed because the
	// YouTube quota was exhausted; it is retried once the quota resets.
	YTLookup bool `json:"-"`
	YTQuota  bool `json:"-"`
}

// Track kinds (#258). Empty is treated as KindAudio.
const (
	KindAudio = "audio"
	KindVideo = "video"
)

// TransportState represents playback transport state
type TransportState struct {
	State             string `json:"state"`
	PositionMs        int64  `json:"positionMs"`
	UpdatedAtServerMs int64  `json:"updatedAtServerMs"`
}

// RoomState represents the current state of a room's queue
type RoomState struct {
	RoomID       string     `json:"roomId"`
	Queue        []TrackRef `json:"queue"`
	NowPlayingID string     `json:"nowPlayingId,omitempty"`
	// History holds tracks that finished or were skipped, newest first, capped
	// at MaxHistory. Queue holds only the playing track (head) plus upcoming
	// ones; see history.go.
	History    []HistoryEntry `json:"history,omitempty"`
	HostUserID string         `json:"hostUserId,omitempty"`
	// OwnerUserID is the room creator. It always reclaims host on (re)join
	// and cannot be demoted or kicked. Empty on rooms that predate it.
	OwnerUserID string `json:"ownerUserId,omitempty"`
	// Admins are userIDs granted full queue and transport control by the
	// host or owner. See roles.go.
	Admins       []string `json:"admins,omitempty"`
	RadioEnabled bool     `json:"radioEnabled"`
	// RadioAvailable reports whether this server can actually refill a radio
	// queue (FEATURE_RADIO on and a similar-tracks provider configured). It is
	// a server capability, not room state: the hub stamps it on every outbound
	// state and it is never persisted. Clients use it to hide or disable the
	// radio toggle.
	RadioAvailable bool `json:"radioAvailable"`
	// YouTubeQuotaUntil is the unix ms until which the server's YouTube search
	// quota is exhausted (0 = available). Like RadioAvailable it is a server
	// condition stamped on every outbound state and never persisted; it lets
	// clients explain why new tracks have no YouTube source.
	YouTubeQuotaUntil int64           `json:"youtubeQuotaUntil,omitempty"`
	Version           int64           `json:"version"`
	Transport         *TransportState `json:"transport,omitempty"`
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

// setNowPlayingID is the single place NowPlayingID changes. When the pointer
// actually moves, an existing Transport is re-anchored to position 0 at the
// current server time, keeping its play/pause state: otherwise the old
// position plus the time since the old play would be applied to the new track
// (minutes in, so listeners seek past the end or loop).
func (rs *RoomState) setNowPlayingID(id string) {
	if rs.NowPlayingID == id {
		return
	}
	rs.NowPlayingID = id
	if rs.Transport != nil {
		rs.Transport.PositionMs = 0
		rs.Transport.UpdatedAtServerMs = time.Now().UnixMilli()
	}
}

// Add appends a track to the queue, generates an ID, stamps the server-side
// AddedAt (overwriting any client-supplied value), and bumps the version.
// If nothing is playing (NowPlayingID empty), the new track starts playing.
// Played tracks leave Queue for History, so the queue is empty whenever
// nothing is playing and the new track is the head.
func (rs *RoomState) Add(track TrackRef) *TrackRef {
	track.ID = uuid.New().String()
	track.AddedAt = time.Now().UnixMilli()
	rs.Queue = append(rs.Queue, track)
	rs.Version++

	if rs.NowPlayingID == "" {
		rs.setNowPlayingID(track.ID)
		rs.moveToFront(track.ID)
		return &rs.Queue[0]
	}

	return &rs.Queue[len(rs.Queue)-1]
}

// Remove removes a track from the queue by ID and bumps the version.
// If the removed track was NowPlayingID it moves to History and playback
// advances to the next queued track, or clears when nothing follows. The
// track's votes go with it so counts never outlive the track (F4).
func (rs *RoomState) Remove(trackID string) error {
	for i, t := range rs.Queue {
		if t.ID == trackID {
			if rs.NowPlayingID == trackID {
				rs.retireNowPlaying()
				rs.switchTo(rs.nextUpcoming())
				rs.Version++
				return nil
			}
			rs.Queue = append(rs.Queue[:i], rs.Queue[i+1:]...)
			delete(rs.Votes, trackID)
			rs.Version++
			return nil
		}
	}
	return fmt.Errorf("%w: %s", ErrTrackNotFound, trackID)
}

// ClearUpcoming removes every upcoming track, keeping the playing head and
// History untouched, drops the votes of the removed tracks and returns how many
// went. Version only bumps when something was removed.
func (rs *RoomState) ClearUpcoming() int {
	kept := make([]TrackRef, 0, 1)
	removed := 0
	for _, t := range rs.Queue {
		if t.ID == rs.NowPlayingID {
			kept = append(kept, t)
			continue
		}
		delete(rs.Votes, t.ID)
		removed++
	}
	if removed == 0 {
		return 0
	}
	rs.Queue = kept
	rs.Version++
	return removed
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

// PruneVoter removes voter from every track's voter set. Used when an
// ephemeral guest connection drops: its keys ("client:<clientID>" without
// room auth, "user:<anonSub>" with it) must not outlive the connection, or a
// reconnecting guest (new clientID/sub) could vote twice on the same track
// (#183, #232). Authenticated "user:<sb:uuid>" keys persist by design — that
// identity survives reconnects, and the hub never passes it here. Bumps
// Version only when a vote was actually removed; reports whether anything
// changed.
func (rs *RoomState) PruneVoter(voter string) bool {
	pruned := false
	for trackID, voters := range rs.Votes {
		for i, v := range voters {
			if v == voter {
				voters = append(voters[:i], voters[i+1:]...)
				pruned = true
				break // set semantics: one entry per voter per track
			}
		}
		if len(voters) == 0 {
			delete(rs.Votes, trackID)
		} else {
			rs.Votes[trackID] = voters
		}
	}
	if pruned {
		rs.Version++
	}
	return pruned
}

// RewriteVoter rekeys every occurrence of oldVoter to newVoter across all
// tracks' voter sets (guest-to-account rebind, #172). When newVoter already
// voted a track, the old key is dropped instead (set semantics: one entry
// per voter per track), so the upgraded member cannot double-vote. Does not
// bump Version: the rebind mutation bumps once for the whole reattribution.
func (rs *RoomState) RewriteVoter(oldVoter, newVoter string) {
	for trackID, voters := range rs.Votes {
		foundOld, foundNew := false, false
		for _, v := range voters {
			if v == oldVoter {
				foundOld = true
			}
			if v == newVoter {
				foundNew = true
			}
		}
		if !foundOld {
			continue
		}
		next := make([]string, 0, len(voters))
		for _, v := range voters {
			if v == oldVoter {
				if !foundNew {
					next = append(next, newVoter)
				}
				continue
			}
			next = append(next, v)
		}
		if len(next) == 0 {
			delete(rs.Votes, trackID)
		} else {
			rs.Votes[trackID] = next
		}
	}
}

// SetNowPlaying sets the now playing track by ID.
// Returns an error if the track is not in the queue.
func (rs *RoomState) SetNowPlaying(trackID string) error {
	for _, t := range rs.Queue {
		if t.ID == trackID {
			if rs.NowPlayingID != trackID {
				rs.retireNowPlaying()
				rs.switchTo(trackID)
			}
			rs.Version++
			return nil
		}
	}
	return fmt.Errorf("%w: %s", ErrTrackNotFound, trackID)
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

	if rs.Track(afterID) == nil {
		return fmt.Errorf("track not found: %s", afterID)
	}

	// The finished track goes to History; the head of what remains plays next,
	// or nothing when the queue is finished.
	rs.retireNowPlaying()
	rs.switchTo(rs.nextUpcoming())
	rs.Version++
	return nil
}

// EndedGraceMs is how far past a track's duration a playing transport may run
// before the server treats the track as ended. It keeps a joiner from racing
// the host's own end-of-track advance, which lands within about a second.
//
// It is also deliberately wide: the catalogue duration of a YouTube-matched
// track is not the video's (the match can be a longer music video), so a
// joiner reconnecting 5 s past a 3:48 catalogue entry must not skip a 4:30
// video that is still playing. Only a transport that ran this far past the
// catalogue end is treated as abandoned. The server cannot know the real video
// length (only the player can), so a video more than 30 s longer than its
// catalogue entry can still be cut on a late join; the matcher keeps matched
// videos close to the catalogue length to make that rare.
const EndedGraceMs = 30_000

// AdvanceIfEnded moves playback past the now-playing track when a playing
// transport has run beyond that track's duration (plus EndedGraceMs). Advance
// is host-only on the client, so a host that vanished (or a server restart that
// restored the transport from the store) leaves the position growing forever
// and every listener seeking past the end. The advance re-anchors the
// transport to position 0 (setNowPlayingID), so one step is enough: a long
// outage does not skip the whole queue. It never refills radio. Tracks with an
// unknown duration are left alone. Reports whether the room advanced.
func (rs *RoomState) AdvanceIfEnded(nowMs int64) bool {
	t := rs.Transport
	if t == nil || t.State != "playing" || rs.NowPlayingID == "" {
		return false
	}
	tr := rs.Track(rs.NowPlayingID)
	if tr == nil || tr.DurationMs <= 0 {
		return false
	}
	if t.PositionMs+(nowMs-t.UpdatedAtServerMs) < tr.DurationMs+EndedGraceMs {
		return false
	}
	return rs.AdvanceAfter(rs.NowPlayingID) == nil
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
		return fmt.Errorf("%w: %s", ErrTrackNotFound, trackID)
	}

	// The playing track stays at the head: it cannot move and nothing may be
	// placed ahead of it.
	if rs.NowPlayingID != "" && len(rs.Queue) > 0 && rs.Queue[0].ID == rs.NowPlayingID {
		if trackID == rs.NowPlayingID {
			return nil
		}
		if toIndex < 1 {
			toIndex = 1
		}
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
