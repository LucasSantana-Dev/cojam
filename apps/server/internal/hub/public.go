package hub

import (
	"encoding/json"
	"sort"
)

// maxPublicRoomsListed caps the v1 public directory (no pagination, no search).
const maxPublicRoomsListed = 20

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
}

// listPublicRooms returns the summaries of rooms currently loaded in the hub
// with Public == true, sorted by memberCount descending (roomId ascending for
// stability) and capped at maxPublicRoomsListed. Read-only: it never calls
// GetOrCreateRoom, so a listing cannot create or load rooms, and it reveals
// nothing about private rooms. Loaded-but-idle rooms (0 members AND an empty
// queue) are filtered as dead; the hub only evicts on a TTL, so without this
// filter a dead public room would linger in the directory until eviction.
//
// memberCount inverts h.members (clientID -> roomIDs), which Join enrolls on
// both room.join and channel subscribe and Leave clears on disconnect. It
// counts connections, so one person in two tabs counts twice (accepted).
func (h *Hub) listPublicRooms() (json.RawMessage, error) {
	// Lock order is memberMu then h.mu (the order evictIdleRooms establishes;
	// Join/Leave take memberMu alone and GetOrCreateRoom takes h.mu alone).
	h.memberMu.RLock()
	h.mu.RLock()
	rooms := make([]PublicRoomSummary, 0, len(h.rooms))
	for roomID, room := range h.rooms {
		room.mu.Lock()
		if !room.State.Public {
			room.mu.Unlock()
			continue
		}
		summary := PublicRoomSummary{
			RoomID: roomID,
			Name:   room.State.Name,
		}
		if room.State.NowPlayingID != "" {
			for _, t := range room.State.Queue {
				if t.ID == room.State.NowPlayingID {
					summary.NowPlaying = &publicRoomTrack{Title: t.Title, Artist: t.Artist}
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
	n := 0
	for _, rooms := range h.members {
		if _, ok := rooms[roomID]; ok {
			n++
		}
	}
	return n
}
