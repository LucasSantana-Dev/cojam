package hub

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// Matcher resolves a YouTube source for a track (nil result = no confident match).
type Matcher func(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error)

// Room holds the state for a music jam room
type Room struct {
	mu    sync.Mutex
	State *queue.RoomState
}

// Hub manages all rooms
type Hub struct {
	mu      sync.RWMutex
	rooms   map[string]*Room
	node    *centrifuge.Node
	logger  *slog.Logger
	metrics *obs.Metrics
	matcher Matcher
}

// WithMatcher enables async YouTube-source enrichment on queue.add.
func (h *Hub) WithMatcher(m Matcher) *Hub {
	h.matcher = m
	return h
}

// WithObservability attaches structured logging + metrics; nil-safe when omitted (tests).
func (h *Hub) WithObservability(logger *slog.Logger, m *obs.Metrics) *Hub {
	h.logger = logger
	h.metrics = m
	if m != nil {
		m.RegisterRoomsGauge(func() float64 {
			h.mu.RLock()
			defer h.mu.RUnlock()
			return float64(len(h.rooms))
		})
	}
	return h
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
// Instrumented: one slog record + one histogram observation per call.
func (h *Hub) HandleRPC(method string, data []byte) (json.RawMessage, error) {
	start := time.Now()
	result, err := h.dispatch(method, data)
	d := time.Since(start)

	if h.metrics != nil {
		h.metrics.ObserveRPC(method, err, d)
	}
	if h.logger != nil {
		var probe struct {
			RoomID string `json:"roomId"`
		}
		_ = json.Unmarshal(data, &probe)
		attrs := []any{
			"method", method,
			"room_id", probe.RoomID,
			"duration_ms", float64(d.Microseconds()) / 1000.0,
		}
		if err != nil {
			h.logger.Error("rpc", append(attrs, "err", err.Error())...)
		} else {
			h.logger.Info("rpc", attrs...)
		}
	}
	return result, err
}

func (h *Hub) dispatch(method string, data []byte) (json.RawMessage, error) {
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
		var addedID string
		res, err := h.mutate(req.RoomID, func(s *queue.RoomState) error {
			addedID = s.Add(req.Track).ID
			return nil
		})
		if err == nil && h.matcher != nil && req.Track.Sources.YouTube == nil {
			go h.enrichYouTube(req.RoomID, addedID, req.Track)
		}
		return res, err

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

// enrichYouTube resolves a YouTube source for a freshly added track and
// republishes the room state (own mutation → version bump → clients accept).
func (h *Hub) enrichYouTube(roomID, trackID string, track queue.TrackRef) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	ref, err := h.matcher(ctx, track.Title, track.Artist, track.ISRC)
	if err != nil || ref == nil {
		if h.logger != nil {
			h.logger.Info("match_miss", "room_id", roomID, "track_id", trackID, "err", fmt.Sprint(err))
		}
		return
	}
	if h.metrics != nil {
		h.metrics.ObserveMatchConfidence(ref.Confidence)
	}
	if _, err := h.mutate(roomID, func(s *queue.RoomState) error {
		return s.SetYouTubeSource(trackID, *ref)
	}); err != nil && h.logger != nil {
		// track may have been removed while resolving — log, don't crash
		h.logger.Info("match_apply_failed", "room_id", roomID, "track_id", trackID, "err", err.Error())
	}
	if h.logger != nil {
		h.logger.Info("match_applied", "room_id", roomID, "track_id", trackID,
			"video_id", ref.VideoID, "confidence", ref.Confidence)
	}
}

// RegisterClient wires a connected client's RPCs to the hub dispatch.
func (h *Hub) RegisterClient(client *centrifuge.Client) {
	client.OnRPC(func(e centrifuge.RPCEvent, cb centrifuge.RPCCallback) {
		reply, err := h.HandleRPC(e.Method, e.Data)
		cb(centrifuge.RPCReply{Data: reply}, err)
	})
}
