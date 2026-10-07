package hub

import (
	"encoding/json"
	"sort"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// maxPublicRoomsListed caps the public directory. Search and sort run
// client-side over this list (#306), so it must be large enough for the
// /rooms page and small enough to stay one cheap RPC reply.
const maxPublicRoomsListed = 100

// publicRoomTrack is the nowPlaying brief of a PublicRoomSummary.
type publicRoomTrack struct {
	Title  string `json:"title"`
	Artist string `json:"artist"`
}

// PublicRoomSummary is the directory view of a public room (room.list).
// Deliberately narrow: queue contents, host id, transport, and vote data stay
// room-channel-only.
type PublicRoomSummary struct {
	RoomID      string           `json:"roomId"`
	Name        string           `json:"name,omitempty"`
	MemberCount int              `json:"memberCount"`
	NowPlaying  *publicRoomTrack `json:"nowPlaying,omitempty"`
	// Kind is "audio" or "video", from the now-playing track (audio when
	// nothing plays or the track predates kinds).
	Kind string `json:"kind"`
	// LastActiveMs is the room's last activity as unix milliseconds.
	LastActiveMs int64 `json:"lastActiveMs"`
}

// listPublicRooms returns the summaries of rooms currently loaded in the hub
// with Public == true, sorted by memberCount descending (roomId ascending for
// stability) and capped at maxPublicRoomsListed. Read-only: it never calls
// GetOrCreateRoom, so a listing cannot create or load rooms, and it reveals
// nothing about private rooms. Loaded-but-idle rooms (0 members AND an empty
// queue) are filtered as dead; the hub only evicts on a TTL, so without this
// filter a dead public room would linger in the directory until eviction.
//
// memberCount reads h.roomMembers (roomID -> clientIDs), the inverted index
// Join enrolls on both room.join and channel subscribe and Leave clears on
// disconnect. It counts connections, so one person in two tabs counts twice
// (accepted).
func (h *Hub) listPublicRooms() (json.RawMessage, error) {
	// Lock order is memberMu then h.mu (the order evictIdleRooms establishes;
	// Join/Leave take memberMu alone and GetOrCreateRoom takes h.mu alone).
	h.memberMu.RLock()
	h.mu.RLock()
	rooms := make([]PublicRoomSummary, 0, len(h.rooms))
	for roomID, room := range h.rooms {
		room.mu.Lock()
		// Defense in depth (#259): a name stored before the filter existed, or
		// changed by a path that skipped it, never reaches the directory.
		if !room.State.Public || roomNameBlocked(room.State.Name) {
			room.mu.Unlock()
			continue
		}
		summary := PublicRoomSummary{
			RoomID: roomID,
			Name:   room.State.Name,
			Kind:   queue.KindAudio,

			LastActiveMs: room.lastActivity().UnixMilli(),
		}
		if room.State.NowPlayingID != "" {
			for _, t := range room.State.Queue {
				if t.ID == room.State.NowPlayingID {
					summary.NowPlaying = &publicRoomTrack{Title: t.Title, Artist: t.Artist}
					if t.Kind == queue.KindVideo {
						summary.Kind = queue.KindVideo
					}
					break
				}
			}
		}
		queueEmpty := len(room.State.Queue) == 0
		room.mu.Unlock()

		summary.MemberCount = h.memberCountLocked(roomID)
		if summary.MemberCount == 0 && queueEmpty {
			continue // dead room
		}
		rooms = append(rooms, summary)
	}
	h.mu.RUnlock()
	h.memberMu.RUnlock()

	sort.Slice(rooms, func(i, j int) bool {
		if rooms[i].MemberCount != rooms[j].MemberCount {
			return rooms[i].MemberCount > rooms[j].MemberCount
		}
		return rooms[i].RoomID < rooms[j].RoomID
	})
	if len(rooms) > maxPublicRoomsListed {
		rooms = rooms[:maxPublicRoomsListed]
	}
	return json.Marshal(map[string]interface{}{"rooms": rooms})
}

// memberCountLocked counts connected clients enrolled in roomID.
// Callers must hold memberMu.
func (h *Hub) memberCountLocked(roomID string) int {
	return len(h.roomMembers[roomID])
}
