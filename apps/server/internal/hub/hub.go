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
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

// Matcher resolves a YouTube source for a track (nil result = no confident match).
type Matcher func(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error)

// SearchResult represents a track search result for the client
type SearchResult struct {
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	Source     string `json:"source"` // "spotify"|"deezer"
	SpotifyURI string `json:"spotifyUri,omitempty"`
	ISRC       string `json:"isrc"`
	DurationMs int    `json:"durationMs"`
	ArtworkURL string `json:"artworkUrl"`
}

// Searcher finds tracks by query
type Searcher func(ctx context.Context, query string, limit int) ([]SearchResult, error)

// PlaylistFetcher fetches tracks from a playlist URL
type PlaylistFetcher func(ctx context.Context, url string) ([]queue.TrackRef, error)

// SimilarProvider fetches tracks similar to a given track (used for radio auto-refill)
type SimilarProvider func(ctx context.Context, artist, title string, limit int) ([]queue.TrackRef, error)

// TrackDepthProvider fetches deep metadata for a track (credits, release year, label, tags)
type TrackDepthProvider func(ctx context.Context, isrc, title, artist string) (interface{}, error)

// LyricsProvider fetches lyrics for a track (synced and plain)
type LyricsProvider func(ctx context.Context, artist, title, album string, durationMs int) (interface{}, error)

// Room holds the state for a music jam room
type Room struct {
	mu    sync.Mutex
	State *queue.RoomState
}

// Hub manages all rooms
type Hub struct {
	mu              sync.RWMutex
	rooms           map[string]*Room
	store           store.Store
	node            *centrifuge.Node
	logger          *slog.Logger
	metrics         *obs.Metrics
	matcher         Matcher
	spotifyMatcher  Matcher
	searcher        Searcher
	playlistFetcher PlaylistFetcher
	similar         SimilarProvider
	trackDepth      TrackDepthProvider
	lyrics          LyricsProvider

	// members gates mutating RPCs: a client may only mutate rooms it has joined
	// (via room.join) or subscribed to. Populated on join/subscribe, cleared on
	// disconnect. Separate mutex from rooms to avoid contention.
	memberMu sync.RWMutex
	members  map[string]map[string]struct{} // clientID -> set of roomIDs
}

// mutatingMethods are RPCs that change room state and therefore require the
// caller to be a member of the target room. room.join enrolls (see Authorize);
// reads and unknown methods fall through to dispatch.
var mutatingMethods = map[string]bool{
	"queue.add":           true,
	"queue.remove":        true,
	"queue.reorder":       true,
	"now_playing.set":     true,
	"now_playing.advance": true,
	"playlist.import":     true,
	"radio.set":           true,
}

// WithMatcher enables async YouTube-source enrichment on queue.add.
func (h *Hub) WithMatcher(m Matcher) *Hub {
	h.matcher = m
	return h
}

// WithStore sets the store implementation for room persistence.
func (h *Hub) WithStore(s store.Store) *Hub {
	h.store = s
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

// NewHub creates a new hub with the given centrifuge node (nil in tests: publish is skipped).
// Defaults to an in-memory store; use WithStore to inject a different implementation.
func NewHub(node *centrifuge.Node) *Hub {
	return &Hub{
		rooms:   make(map[string]*Room),
		store:   store.NewMemory(),
		node:    node,
		members: make(map[string]map[string]struct{}),
	}
}

// Join enrolls a client as a member of a room (called on room.join and on
// channel subscribe, so membership survives centrifuge reconnects).
func (h *Hub) Join(clientID, roomID string) {
	if clientID == "" || roomID == "" {
		return
	}
	h.memberMu.Lock()
	defer h.memberMu.Unlock()
	if h.members[clientID] == nil {
		h.members[clientID] = make(map[string]struct{})
	}
	h.members[clientID][roomID] = struct{}{}
}

// Leave drops all of a client's memberships (called on disconnect).
func (h *Hub) Leave(clientID string) {
	h.memberMu.Lock()
	defer h.memberMu.Unlock()
	delete(h.members, clientID)
}

// IsMember reports whether a client has joined/subscribed to a room.
func (h *Hub) IsMember(clientID, roomID string) bool {
	h.memberMu.RLock()
	defer h.memberMu.RUnlock()
	_, ok := h.members[clientID][roomID]
	return ok
}

// Authorize gates a client's RPC before dispatch. room.join enrolls the client
// and is always allowed. Mutating methods require membership of the target room,
// else ErrorPermissionDenied. Reads/unknown methods pass through (dispatch owns
// unknown-method + roomId-required errors). Called at the transport boundary
// where the clientID is known, keeping HandleRPC transport-independent.
func (h *Hub) Authorize(clientID, method string, data []byte) error {
	var probe struct {
		RoomID string `json:"roomId"`
	}
	_ = json.Unmarshal(data, &probe)

	if method == "room.join" {
		h.Join(clientID, probe.RoomID)
		return nil
	}
	if !mutatingMethods[method] {
		return nil
	}
	if probe.RoomID == "" {
		return nil // let dispatch return the roomId-required error
	}
	if !h.IsMember(clientID, probe.RoomID) {
		return centrifuge.ErrorPermissionDenied
	}
	return nil
}

// GetOrCreateRoom retrieves or creates a room, with read-through to the store.
// If the room is not in the map, Load from store. On ErrNotFound, create a fresh room
// and persist it. On other errors, log and create a fresh room (best-effort recovery).
func (h *Hub) GetOrCreateRoom(roomID string) *Room {
	h.mu.Lock()
	if room, exists := h.rooms[roomID]; exists {
		h.mu.Unlock()
		return room
	}
	h.mu.Unlock()

	// Try to load from store
	ctx := context.Background()
	state, err := h.store.Load(ctx, roomID)

	// If found in store, use it
	if err == nil && state != nil {
		h.mu.Lock()
		room := &Room{State: state}
		h.rooms[roomID] = room
		h.mu.Unlock()
		return room
	}

	// If not found or error, create fresh
	if err != nil && err != store.ErrNotFound && h.logger != nil {
		h.logger.Error("store_load_failed", "room_id", roomID, "err", err.Error())
	}

	state = &queue.RoomState{
		RoomID:  roomID,
		Queue:   []queue.TrackRef{},
		Version: 0,
	}

	// Persist the fresh room
	if err := h.store.Save(ctx, state); err != nil && h.logger != nil {
		h.logger.Error("store_save_failed", "room_id", roomID, "err", err.Error())
	}

	h.mu.Lock()
	room := &Room{State: state}
	h.rooms[roomID] = room
	h.mu.Unlock()
	return room
}

// mutate applies fn to the room under its lock, marshals the resulting state while
// still holding the lock (state is a pointer; marshaling outside would race), releases
// the lock, then persists to the store and publishes the snapshot to the room channel.
// The state is deep-copied before releasing the lock to prevent data races.
// Store errors are logged but non-fatal to the mutation result.
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

	if fn != nil {
		// Write-through: persist state after releasing room lock.
		// Unmarshal the JSON to get a deep copy safe for store.Save.
		var stateCopy queue.RoomState
		if err := json.Unmarshal(data, &stateCopy); err != nil {
			if h.logger != nil {
				h.logger.Error("store_marshal_failed", "room_id", roomID, "err", err.Error())
			}
		} else {
			ctx := context.Background()
			if err := h.store.Save(ctx, &stateCopy); err != nil && h.logger != nil {
				h.logger.Error("store_save_failed", "room_id", roomID, "err", err.Error())
			}
		}

		// Publish to room channel
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
			if len(s.Queue) >= queue.MaxQueueSize {
				return fmt.Errorf("queue.add: queue full (max %d)", queue.MaxQueueSize)
			}
			addedID = s.Add(req.Track).ID
			return nil
		})
		if err == nil && h.matcher != nil && req.Track.Sources.YouTube == nil {
			go h.enrichYouTube(req.RoomID, addedID, req.Track)
		}
		if err == nil && h.spotifyMatcher != nil && req.Track.Sources.Spotify == nil {
			go h.enrichSpotify(req.RoomID, addedID, req.Track)
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

	case "now_playing.advance":
		var req struct {
			RoomID  string `json:"roomId"`
			AfterID string `json:"afterId"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		if req.RoomID == "" {
			return nil, fmt.Errorf("now_playing.advance: roomId required")
		}

		// Capture seed for potential radio refill (if queue runs dry)
		var refillSeed *queue.TrackRef

		res, err := h.mutate(req.RoomID, func(s *queue.RoomState) error {
			// Store old NowPlayingID to detect if advance actually changed state
			oldNowPlayingID := s.NowPlayingID

			if err := s.AdvanceAfter(req.AfterID); err != nil {
				return err
			}

			// Detect if advance actually changed state and queue is now empty
			if s.NowPlayingID != oldNowPlayingID && s.RadioEnabled && s.NowPlayingID == "" && len(s.Queue) > 0 {
				// Queue ran dry; capture the last track as seed for refill
				refillSeed = &s.Queue[len(s.Queue)-1]
			}

			return nil
		})

		// After successful mutate, trigger refill if needed (async, outside the lock)
		if err == nil && refillSeed != nil && h.similar != nil {
			go h.refillRadio(req.RoomID, refillSeed)
		}

		return res, err

	case "queue.reorder":
		var req struct {
			RoomID  string `json:"roomId"`
			TrackID string `json:"trackId"`
			ToIndex int    `json:"toIndex"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		if req.RoomID == "" {
			return nil, fmt.Errorf("queue.reorder: roomId required")
		}
		return h.mutate(req.RoomID, func(s *queue.RoomState) error {
			return s.Move(req.TrackID, req.ToIndex)
		})

	case "track.search":
		var req struct {
			Query string `json:"query"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}

		// If searcher not configured, return empty array
		if h.searcher == nil {
			return json.Marshal([]SearchResult{})
		}

		// Use a short timeout for search
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		results, err := h.searcher(ctx, req.Query, 8)
		if err != nil {
			// Log error but return empty array instead of failing the RPC
			if h.logger != nil {
				h.logger.Error("search_failed", "query", req.Query, "err", err.Error())
			}
			return json.Marshal([]SearchResult{})
		}

		return json.Marshal(results)

	case "track.depth":
		var req struct {
			RoomID string `json:"roomId"`
			ISRC   string `json:"isrc"`
			Title  string `json:"title"`
			Artist string `json:"artist"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}

		// If track depth provider not configured, return empty result
		if h.trackDepth == nil {
			return json.Marshal(map[string]interface{}{
				"credits": []interface{}{},
				"tags":    []string{},
				"source":  "musicbrainz",
			})
		}

		// Use a short timeout for depth lookup
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		result, err := h.trackDepth(ctx, req.ISRC, req.Title, req.Artist)
		if err != nil {
			// Log error but return empty result instead of failing the RPC
			if h.logger != nil {
				h.logger.Error("track_depth_failed", "title", req.Title, "artist", req.Artist, "err", err.Error())
			}
			return json.Marshal(map[string]interface{}{
				"credits": []interface{}{},
				"tags":    []string{},
				"source":  "musicbrainz",
			})
		}

		return json.Marshal(result)

	case "track.lyrics":
		var req struct {
			RoomID     string `json:"roomId"`
			Artist     string `json:"artist"`
			Title      string `json:"title"`
			Album      string `json:"album"`
			DurationMs int    `json:"durationMs"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}

		empty := map[string]interface{}{"synced": []interface{}{}, "plain": "", "source": "lrclib"}
		if h.lyrics == nil {
			return json.Marshal(empty)
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		result, err := h.lyrics(ctx, req.Artist, req.Title, req.Album, req.DurationMs)
		if err != nil {
			// Log but return empty (a miss is not an RPC failure).
			if h.logger != nil {
				h.logger.Error("track_lyrics_failed", "title", req.Title, "artist", req.Artist, "err", err.Error())
			}
			return json.Marshal(empty)
		}

		return json.Marshal(result)

	case "playlist.import":
		var req struct {
			RoomID  string `json:"roomId"`
			URL     string `json:"url"`
			AddedBy string `json:"addedBy"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		if req.RoomID == "" {
			return nil, fmt.Errorf("playlist.import: roomId required")
		}
		if req.URL == "" {
			return nil, fmt.Errorf("playlist.import: url required")
		}

		// If playlist fetcher not configured, return error
		if h.playlistFetcher == nil {
			return nil, fmt.Errorf("playlist.import: not configured")
		}

		// Fetch playlist tracks (short timeout to not block the RPC too long)
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		tracks, err := h.playlistFetcher(ctx, req.URL)
		if err != nil {
			return nil, fmt.Errorf("playlist.import: %w", err)
		}

		// Add tracks to queue up to capacity, set AddedBy on each
		res, mutErr := h.mutate(req.RoomID, func(s *queue.RoomState) error {
			remaining := queue.MaxQueueSize - len(s.Queue)
			if remaining <= 0 {
				return fmt.Errorf("queue full")
			}

			toAdd := tracks
			if len(tracks) > remaining {
				toAdd = tracks[:remaining]
			}

			for _, track := range toAdd {
				track.AddedBy = req.AddedBy
				s.Add(track)
			}
			return nil
		})

		// After successful mutate, enrich tracks that were added
		if mutErr == nil && len(tracks) > 0 {
			// Get the updated room state to find the newly added tracks
			room := h.GetOrCreateRoom(req.RoomID)
			room.mu.Lock()
			addedCount := len(tracks)
			if len(tracks) > queue.MaxQueueSize {
				addedCount = queue.MaxQueueSize
			}
			// Get the last N tracks added (they're at the end of the queue)
			startIdx := len(room.State.Queue) - addedCount
			if startIdx < 0 {
				startIdx = 0
			}
			newTracks := room.State.Queue[startIdx:]
			room.mu.Unlock()

			// Launch enrichment for tracks lacking sources
			for _, track := range newTracks {
				if h.matcher != nil && track.Sources.YouTube == nil {
					go h.enrichYouTube(req.RoomID, track.ID, track)
				}
				if h.spotifyMatcher != nil && track.Sources.Spotify == nil {
					go h.enrichSpotify(req.RoomID, track.ID, track)
				}
			}
		}

		return res, mutErr

	case "radio.set":
		var req struct {
			RoomID  string `json:"roomId"`
			Enabled bool   `json:"enabled"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		if req.RoomID == "" {
			return nil, fmt.Errorf("radio.set: roomId required")
		}
		return h.mutate(req.RoomID, func(s *queue.RoomState) error {
			s.RadioEnabled = req.Enabled
			s.Version++ // bump so clients accept the publication (setState version guard)
			return nil
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
		// Trust boundary: reject mutations of rooms this client hasn't joined.
		if err := h.Authorize(client.ID(), e.Method, e.Data); err != nil {
			cb(centrifuge.RPCReply{}, err)
			return
		}
		reply, err := h.HandleRPC(e.Method, e.Data)
		cb(centrifuge.RPCReply{Data: reply}, err)
	})
}

// WithSpotifyMatcher enables async Spotify-source enrichment on queue.add.
func (h *Hub) WithSpotifyMatcher(m Matcher) *Hub {
	h.spotifyMatcher = m
	return h
}

// WithSearcher enables track search via track.search RPC.
func (h *Hub) WithSearcher(s Searcher) *Hub {
	h.searcher = s
	return h
}

// WithPlaylistFetcher enables playlist import via playlist.import RPC.
func (h *Hub) WithPlaylistFetcher(pf PlaylistFetcher) *Hub {
	h.playlistFetcher = pf
	return h
}

// WithSimilarProvider enables radio auto-refill via similar-track lookup.
func (h *Hub) WithSimilarProvider(sp SimilarProvider) *Hub {
	h.similar = sp
	return h
}

// WithTrackDepthProvider enables track.depth RPC for fetching deep metadata.
func (h *Hub) WithTrackDepthProvider(tdp TrackDepthProvider) *Hub {
	h.trackDepth = tdp
	return h
}

// WithLyricsProvider enables track.lyrics RPC for fetching lyrics.
func (h *Hub) WithLyricsProvider(lp LyricsProvider) *Hub {
	h.lyrics = lp
	return h
}

// enrichSpotify resolves a Spotify source for a freshly added track and
// republishes the room state (own mutation -> version bump -> clients accept).
func (h *Hub) enrichSpotify(roomID, trackID string, track queue.TrackRef) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	ref, err := h.spotifyMatcher(ctx, track.Title, track.Artist, track.ISRC)
	if err != nil || ref == nil {
		if h.logger != nil {
			h.logger.Info("spotify_match_miss", "room_id", roomID, "track_id", trackID, "err", fmt.Sprint(err))
		}
		return
	}
	if h.metrics != nil {
		h.metrics.ObserveMatchConfidence(ref.Confidence)
	}
	if _, err := h.mutate(roomID, func(s *queue.RoomState) error {
		return s.SetSpotifySource(trackID, *ref)
	}); err != nil && h.logger != nil {
		// track may have been removed while resolving - log, don't crash
		h.logger.Info("spotify_match_apply_failed", "room_id", roomID, "track_id", trackID, "err", err.Error())
	}
	if h.logger != nil {
		h.logger.Info("spotify_match_applied", "room_id", roomID, "track_id", trackID,
			"track_uri", ref.TrackURI, "confidence", ref.Confidence)
	}
}

// refillRadio fetches similar tracks and appends them to the queue when it runs dry.
// Idempotent: re-checks that queue is still empty before appending (so a duplicate
// refill from concurrent advances is a no-op).
func (h *Hub) refillRadio(roomID string, seed *queue.TrackRef) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	similar, err := h.similar(ctx, seed.Artist, seed.Title, 5)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("radio_fetch_failed", "room_id", roomID, "track", seed.Title, "artist", seed.Artist, "err", err.Error())
		}
		return
	}

	// Append similar tracks, guarded by re-checking queue is still waiting (idempotency).
	_, err = h.mutate(roomID, func(s *queue.RoomState) error {
		// Guard: only refill if queue still has no next track (NowPlayingID empty)
		// and radio is still enabled. If another client queued a track or disabled
		// radio in the interim, this is a no-op.
		if s.NowPlayingID != "" {
			return nil // Another client queued a next track
		}
		if !s.RadioEnabled {
			return nil // Radio was disabled
		}

		// Append up to N similar tracks without exceeding MaxQueueSize
		for _, track := range similar {
			if len(s.Queue) >= queue.MaxQueueSize {
				break
			}
			track.AddedBy = "radio"
			s.Add(track)
		}

		return nil
	})

	if err != nil && h.logger != nil {
		h.logger.Error("radio_append_failed", "room_id", roomID, "err", err.Error())
	} else if err == nil && len(similar) > 0 && h.logger != nil {
		h.logger.Info("radio_refill", "room_id", roomID, "track", seed.Title, "artist", seed.Artist, "appended", len(similar))
	}
}
