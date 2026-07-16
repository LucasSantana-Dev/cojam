package hub

import (
	"encoding/json"
	"fmt"
	"sync"

	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/music-jam/server/internal/queue"
)

// Room holds the state for a music jam room
type Room struct {
	mu    sync.Mutex
	State *queue.RoomState
}

// Hub manages all rooms
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]*Room
	node  *centrifuge.Node
}

// NewHub creates a new hub with the given centrifuge node (nil in tests: publish is skipped)
func NewHub(node *centrifuge.Node) *Hub {
	return &Hub{
		rooms: make(map[string]*Room),
		node:  node,
	}
}

// GetOrCreateRoom retrieves or creates a room
func (h *Hub) GetOrCreateRoom(roomID string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()

	if room, exists := h.rooms[roomID]; exists {
		return room
	}

	room := &Room{
		State: &queue.RoomState{
			RoomID:  roomID,
			Queue:   []queue.TrackRef{},
			Version: 0,
		},
	}
	h.rooms[roomID] = room
	return room
}

// mutate applies fn to the room under its lock, marshals the resulting state while
// still holding the lock (state is a pointer; marshaling outside would race), then
// publishes the snapshot to the room channel.
func (h *Hub) mutate(roomID string, fn func(*queue.RoomState) error) (json.RawMessage, error) {
	room := h.GetOrCreateRoom(roomID)

	room.mu.Lock()
	if fn != nil {
		if err := fn(room.State); err != nil {
			room.mu.Unlock()
			return nil, err
		}
	}
	data, err := json.Marshal(room.State)
	room.mu.Unlock()
	if err != nil {
		return nil, err
	}

	if fn != nil { // reads don't publish
		if err := h.publish(roomID, data); err != nil {
			return nil, err
		}
	}
	return data, nil
}

func (h *Hub) publish(roomID string, state json.RawMessage) error {
	if h.node == nil { // test mode
		return nil
	}
	payload, err := json.Marshal(map[string]json.RawMessage{
		"type":  json.RawMessage(`"room.state"`),
		"state": state,
	})
	if err != nil {
		return err
	}
	_, err = h.node.Publish("room:"+roomID, payload)
	return err
}

// HandleRPC is the transport-independent RPC dispatch per docs/protocol.md.
// Every method takes roomId from params; every result is the full RoomState.
func (h *Hub) HandleRPC(method string, data []byte) (json.RawMessage, error) {
	switch method {
	case "room.join":
		var req struct {
			RoomID string `json:"roomId"`
			Name   string `json:"name"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		if req.RoomID == "" {
			return nil, fmt.Errorf("room.join: roomId required")
		}
		return h.mutate(req.RoomID, nil)

	case "queue.add":
		var req struct {
			RoomID string         `json:"roomId"`
			Track  queue.TrackRef `json:"track"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		if req.RoomID == "" {
			return nil, fmt.Errorf("queue.add: roomId required")
		}
		return h.mutate(req.RoomID, func(s *queue.RoomState) error {
			s.Add(req.Track)
			return nil
		})

	case "queue.remove":
		var req struct {
			RoomID  string `json:"roomId"`
			TrackID string `json:"trackId"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		return h.mutate(req.RoomID, func(s *queue.RoomState) error {
			return s.Remove(req.TrackID)
		})

	case "now_playing.set":
		var req struct {
			RoomID  string `json:"roomId"`
			TrackID string `json:"trackId"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		return h.mutate(req.RoomID, func(s *queue.RoomState) error {
			return s.SetNowPlaying(req.TrackID)
		})

	default:
		return nil, centrifuge.ErrorMethodNotFound
	}
}

// RegisterClient wires a connected client's RPCs to the hub dispatch.
func (h *Hub) RegisterClient(client *centrifuge.Client) {
	client.OnRPC(func(e centrifuge.RPCEvent, cb centrifuge.RPCCallback) {
		reply, err := h.HandleRPC(e.Method, e.Data)
		cb(centrifuge.RPCReply{Data: reply}, err)
	})
}
