package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sync"
	"time"

	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
	"github.com/LucasSantana-Dev/cojam/server/internal/playlist"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

// maxImportTracks bounds client-supplied playlist imports (RFC-0007). 200 track
// refs at ~250 bytes of JSON each stay under centrifuge's default 64 KiB message
// limit; a larger frame would drop the websocket instead of returning an error.
const maxImportTracks = 200

// maxImportFieldLen caps free-text fields coming from clients.
const maxImportFieldLen = 300

// maxImportDurationMs bounds track duration (2 hours); longer is a client bug.
const maxImportDurationMs = 2 * 60 * 60 * 1000

var spotifyTrackURIRe = regexp.MustCompile(`^spotify:track:[0-9A-Za-z]{22}$`)

// validateImportTracks checks client-supplied track metadata before enqueueing
// (RFC-0007). The data crosses a trust boundary: it claims to come from a
// provider playlist but is arbitrary client input, so cap sizes and shapes.
// Errors are user-facing (UserError) so the host sees why the import failed.
func validateImportTracks(tracks []queue.TrackRef) error {
	if len(tracks) > maxImportTracks {
		return userErrorf("too many tracks: %d (max %d per import)", len(tracks), maxImportTracks)
	}
	for i, t := range tracks {
		if t.Title == "" {
			return userErrorf("track %d: title is required", i+1)
		}
		if len(t.Title) > maxImportFieldLen {
			return userErrorf("track %d: title too long (max %d chars)", i+1, maxImportFieldLen)
		}
		if len(t.Artist) > maxImportFieldLen {
			return userErrorf("track %d: artist too long (max %d chars)", i+1, maxImportFieldLen)
		}
		if t.DurationMs < 0 || t.DurationMs > maxImportDurationMs {
			return userErrorf("track %d: duration out of range", i+1)
		}
		if len(t.ISRC) > maxImportFieldLen {
			return userErrorf("track %d: isrc too long", i+1)
		}
		if t.Sources.YouTube != nil && len(t.Sources.YouTube.VideoID) > maxImportFieldLen {
			return userErrorf("track %d: youtube video id too long", i+1)
		}
		if t.Sources.Apple != nil && len(t.Sources.Apple.SongID) > maxImportFieldLen {
			return userErrorf("track %d: apple song id too long", i+1)
		}
		if t.Sources.Spotify != nil && t.Sources.Spotify.TrackURI != "" &&
			!spotifyTrackURIRe.MatchString(t.Sources.Spotify.TrackURI) {
			return userErrorf("track %d: invalid spotify track URI", i+1)
		}
	}
	return nil
}

// UserError wraps an error whose message is safe and useful to show to the
// client. Centrifuge masks plain errors into code 100 "internal server error",
// so user-actionable failures (bad input, unconfigured provider, full queue)
// must cross the transport as *centrifuge.Error; rpcClientError does that.
type UserError struct{ msg string }

func (e *UserError) Error() string { return e.msg }

func userErrorf(format string, args ...interface{}) *UserError {
	return &UserError{msg: fmt.Sprintf(format, args...)}
}

// rpcClientError converts UserError into a centrifuge client-visible error
// (application code range 400-1999) and passes every other error through
// unchanged so centrifuge still masks internal details as code 100.
func rpcClientError(err error) error {
	var ue *UserError
	if errors.As(err, &ue) {
		return &centrifuge.Error{Code: 400, Message: ue.msg}
	}
	return err
}

// Client is the minimal interface for a connected client in the Authorize path.
// centrifuge.Client and testClient both implement this interface.
type Client interface {
	ID() string
	UserID() string
}

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

// Searcher finds tracks by query. prefer lists the caller's connected providers
// (e.g. "spotify"); implementations may use it to rank results. May be empty.
type Searcher func(ctx context.Context, query string, prefer []string, limit int) ([]SearchResult, error)

// PlaylistFetcher fetches tracks from a playlist URL
type PlaylistFetcher func(ctx context.Context, url string) ([]queue.TrackRef, error)

// SimilarProvider fetches tracks similar to a given track (used for radio auto-refill)
type SimilarProvider func(ctx context.Context, artist, title string, limit int) ([]queue.TrackRef, error)

// TrackDepthProvider fetches deep metadata for a track (credits, release year, label, tags)
type TrackDepthProvider func(ctx context.Context, isrc, title, artist string) (interface{}, error)

// LyricsProvider fetches lyrics for a track (synced and plain)
type LyricsProvider func(ctx context.Context, artist, title, album string, durationMs int) (interface{}, error)

// ListenBrainzProvider fetches enrichment data from ListenBrainz (tags, listen counts)
type ListenBrainzProvider func(ctx context.Context, isrc, title, artist string) (interface{}, error)

// LastfmEnrichProvider fetches enrichment data from Last.fm (playcount, listeners, tags)
type LastfmEnrichProvider func(ctx context.Context, artist, title string) (interface{}, error)

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
	listenBrainz    ListenBrainzProvider
	lastfmEnrich    LastfmEnrichProvider
	syncEnabled     bool

	// fanoutLimiter rate-limits RPCs that fan out to third-party APIs
	// (fanoutMethods) per caller, protecting upstream provider quotas.
	fanoutLimiter *rateLimiter

	// enrichSem bounds concurrent outbound matcher lookups. Bulk imports can add
	// up to 200 tracks at once; an unbounded goroutine per track would burst
	// hundreds of simultaneous YouTube/Spotify requests and trip rate limits.
	enrichSem chan struct{}

	// members gates mutating RPCs: a client may only mutate rooms it has joined
	// (via room.join) or subscribed to. Populated on join/subscribe, cleared on
	// disconnect. Separate mutex from rooms to avoid contention.
	memberMu sync.RWMutex
	members  map[string]map[string]struct{} // clientID -> set of roomIDs

	// clientUserID tracks authenticated userID per clientID for host assignment (U3+).
	// Populated on room.join when FEATURE_ROOM_AUTH is on.
	clientUserIDMu sync.RWMutex
	clientUserID   map[string]string // clientID -> userID
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
	"transport.play":      true,
	"transport.pause":     true,
	"transport.seek":      true,
}

// hostOnlyMethods are mutating RPCs that disrupt room control and therefore
// require the caller to be the room's host (RFC-0005 U4).
// queue.add and room.join are always allowed for members.
// TODO(RFC-0005): allow listeners to remove their own tracks once AddedBy carries userID.
var hostOnlyMethods = map[string]bool{
	"now_playing.set":     true,
	"now_playing.advance": true,
	"queue.reorder":       true,
	"queue.remove":        true,
	"radio.set":           true,
	"playlist.import":     true,
	"transport.play":      true,
	"transport.pause":     true,
	"transport.seek":      true,
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

// WithSync enables synchronized playback transport RPCs (transport.play/pause/seek).
func (h *Hub) WithSync(enabled bool) *Hub {
	h.syncEnabled = enabled
	return h
}

// NewHub creates a new hub with the given centrifuge node (nil in tests: publish is skipped).
// Defaults to an in-memory store; use WithStore to inject a different implementation.
func NewHub(node *centrifuge.Node) *Hub {
	return &Hub{
		rooms:         make(map[string]*Room),
		store:         store.NewMemory(),
		node:          node,
		members:       make(map[string]map[string]struct{}),
		clientUserID:  make(map[string]string),
		enrichSem:     make(chan struct{}, 8),
		fanoutLimiter: newRateLimiter(fanoutBurst, fanoutRefill, time.Now),
	}
}

// launchEnrich runs fn in a goroutine gated by enrichSem so bulk imports cannot
// fire unbounded concurrent matcher lookups.
func (h *Hub) launchEnrich(fn func()) {
	go func() {
		h.enrichSem <- struct{}{}
		defer func() { <-h.enrichSem }()
		fn()
	}()
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

// RecordClientUserID tracks the userID for a client (called when joining with auth).
func (h *Hub) RecordClientUserID(clientID, userID string) {
	if clientID == "" {
		return
	}
	h.clientUserIDMu.Lock()
	defer h.clientUserIDMu.Unlock()
	if userID != "" {
		h.clientUserID[clientID] = userID
	}
}

// RemoveClientUserID removes the userID tracking for a client (called on disconnect).
func (h *Hub) RemoveClientUserID(clientID string) {
	h.clientUserIDMu.Lock()
	defer h.clientUserIDMu.Unlock()
	delete(h.clientUserID, clientID)
}

// IsUserIDInRoom checks if a given userID has an active member in the room.
func (h *Hub) IsUserIDInRoom(roomID, userID string) bool {
	if userID == "" {
		return false
	}
	h.memberMu.RLock()
	defer h.memberMu.RUnlock()

	h.clientUserIDMu.RLock()
	defer h.clientUserIDMu.RUnlock()

	// Iterate through all members and check if any have the target userID in this room
	for clientID, rooms := range h.members {
		if _, inRoom := rooms[roomID]; inRoom {
			if h.clientUserID[clientID] == userID {
				return true
			}
		}
	}
	return false
}

// GetHostUserID returns the hostUserID for a room, or empty if no host is assigned.
// Called inside Authorize to enforce host-only methods.
func (h *Hub) GetHostUserID(roomID string) string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	room, exists := h.rooms[roomID]
	if !exists {
		return "" // room not loaded yet; no host
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	return room.State.HostUserID
}

// Authorize gates a client's RPC before dispatch. room.join enrolls the client
// and is always allowed. Mutating methods require membership of the target room,
// else ErrorPermissionDenied. Reads/unknown methods pass through (dispatch owns
// unknown-method + roomId-required errors). Called at the transport boundary
// where the client is known, allowing access to authenticated userID.
func (h *Hub) Authorize(client Client, method string, data []byte) error {
	clientID := client.ID()
	userID := client.UserID() // UserID is available here for authenticated requests (U4+)

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

	// Host-only gate (RFC-0005 U4): if method is host-only and room has a host,
	// only the host can execute. When HostUserID is empty (flag off), this check
	// is skipped, preserving v0 equal-member behavior.
	if hostOnlyMethods[method] {
		hostUserID := h.GetHostUserID(probe.RoomID)
		if hostUserID != "" && userID != hostUserID {
			return centrifuge.ErrorPermissionDenied
		}
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
// userID is the authenticated user (empty if anonymous or FEATURE_ROOM_AUTH is off).
// Instrumented: one slog record + one histogram observation per call.
func (h *Hub) HandleRPC(method string, data []byte, userID string) (json.RawMessage, error) {
	return h.handleRPC(method, data, userID, rateLimitKey("", userID))
}

// handleRPC is HandleRPC with an explicit rate-limit key. The transport layer
// passes a client-scoped key when no authenticated userID exists so anonymous
// clients are limited per connection instead of sharing one bucket.
func (h *Hub) handleRPC(method string, data []byte, userID, rlKey string) (json.RawMessage, error) {
	start := time.Now()
	// Fanout RPCs are rate-limited per caller before doing any work; a
	// rejection surfaces as a UserError (centrifuge code 400) via
	// rpcClientError and does not touch other methods' budgets.
	var result json.RawMessage
	err := h.checkFanoutLimit(method, rlKey)
	if err == nil {
		result, err = h.dispatch(method, data, userID)
	}
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

// checkFanoutLimit enforces the per-caller token bucket on RPCs that fan out
// to third-party APIs. Returns nil for unlimited methods.
func (h *Hub) checkFanoutLimit(method, rlKey string) error {
	if !fanoutMethods[method] || h.fanoutLimiter == nil {
		return nil
	}
	if !h.fanoutLimiter.allow(rlKey) {
		return userErrorf("too many requests, slow down")
	}
	return nil
}

func (h *Hub) dispatch(method string, data []byte, userID string) (json.RawMessage, error) {
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
		return h.mutate(req.RoomID, func(s *queue.RoomState) error {
			// Set host if authenticated and room has no host yet.
			// If host left the room, reclaim for the new joiner.
			if userID != "" {
				if s.HostUserID == "" {
					// Fresh room: first authenticated joiner becomes host
					s.HostUserID = userID
					s.Version++ // host changed: bump so version-guarded clients accept it
				} else if !h.IsUserIDInRoom(req.RoomID, s.HostUserID) {
					// Host is not present: claim host
					s.HostUserID = userID
					s.Version++ // host changed: bump so version-guarded clients accept it
				}
				// else: host is present, don't reassign
			}
			// When userID is empty (FEATURE_ROOM_AUTH off), HostUserID stays empty
			return nil
		})

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
			h.launchEnrich(func() { h.enrichYouTube(req.RoomID, addedID, req.Track) })
		}
		if err == nil && h.spotifyMatcher != nil && req.Track.Sources.Spotify == nil {
			h.launchEnrich(func() { h.enrichSpotify(req.RoomID, addedID, req.Track) })
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
			Query  string   `json:"query"`
			Prefer []string `json:"prefer"`
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

		results, err := h.searcher(ctx, req.Query, req.Prefer, 8)
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

	case "track.listenbrainz":
		var req struct {
			RoomID string `json:"roomId"`
			ISRC   string `json:"isrc"`
			Title  string `json:"title"`
			Artist string `json:"artist"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}

		// If listenbrainz provider not configured, return empty result
		if h.listenBrainz == nil {
			return json.Marshal(map[string]interface{}{
				"mbid":   "",
				"tags":   []string{},
				"source": "listenbrainz",
			})
		}

		// Use a short timeout for listenbrainz lookup
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		result, err := h.listenBrainz(ctx, req.ISRC, req.Title, req.Artist)
		if err != nil {
			// Log error but return empty result instead of failing the RPC
			if h.logger != nil {
				h.logger.Error("listenbrainz_failed", "title", req.Title, "artist", req.Artist, "err", err.Error())
			}
			return json.Marshal(map[string]interface{}{
				"mbid":   "",
				"tags":   []string{},
				"source": "listenbrainz",
			})
		}

		return json.Marshal(result)

	case "track.lastfm":
		var req struct {
			RoomID string `json:"roomId"`
			Artist string `json:"artist"`
			Title  string `json:"title"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}

		// If lastfm provider not configured, return empty result
		if h.lastfmEnrich == nil {
			return json.Marshal(map[string]interface{}{
				"playcount": 0,
				"listeners": 0,
				"tags":      []string{},
				"source":    "lastfm",
			})
		}

		// Use a short timeout for lastfm lookup
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		result, err := h.lastfmEnrich(ctx, req.Artist, req.Title)
		if err != nil {
			// Log error but return empty result instead of failing the RPC
			if h.logger != nil {
				h.logger.Error("lastfm_enrich_failed", "title", req.Title, "artist", req.Artist, "err", err.Error())
			}
			return json.Marshal(map[string]interface{}{
				"playcount": 0,
				"listeners": 0,
				"tags":      []string{},
				"source":    "lastfm",
			})
		}

		return json.Marshal(result)

	case "playlist.import":
		var req struct {
			RoomID  string           `json:"roomId"`
			URL     string           `json:"url"`
			AddedBy string           `json:"addedBy"`
			Tracks  []queue.TrackRef `json:"tracks"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		if req.RoomID == "" {
			return nil, userErrorf("room id required")
		}
		if req.URL == "" {
			return nil, userErrorf("enter a playlist URL")
		}

		var tracks []queue.TrackRef
		if len(req.Tracks) > 0 {
			// Client-supplied tracks (RFC-0007: Spotify import via the user's own
			// OAuth token in the browser). The server never sees the token, only
			// resolved metadata, which must be validated before enqueueing.
			if err := validateImportTracks(req.Tracks); err != nil {
				return nil, err
			}
			tracks = req.Tracks
		} else {
			// If playlist fetcher not configured, return error
			if h.playlistFetcher == nil {
				return nil, userErrorf("playlist import is not enabled on this server")
			}

			// Fetch playlist tracks (short timeout to not block the RPC too long)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()

			var err error
			tracks, err = h.playlistFetcher(ctx, req.URL)
			if err != nil {
				// Fetcher errors are already sanitized (no upstream bodies, see
				// httpx/playlist packages), so they are safe to show the user.
				if errors.Is(err, playlist.ErrNotConfigured) {
					return nil, userErrorf("this playlist service is not configured on the server (Spotify import needs server credentials)")
				}
				return nil, userErrorf("could not load playlist: %v", err)
			}
		}

		// Add tracks to queue up to capacity, set AddedBy on each
		res, mutErr := h.mutate(req.RoomID, func(s *queue.RoomState) error {
			remaining := queue.MaxQueueSize - len(s.Queue)
			if remaining <= 0 {
				return userErrorf("queue is full")
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
					h.launchEnrich(func() { h.enrichYouTube(req.RoomID, track.ID, track) })
				}
				if h.spotifyMatcher != nil && track.Sources.Spotify == nil {
					h.launchEnrich(func() { h.enrichSpotify(req.RoomID, track.ID, track) })
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

	case "transport.play":
		if !h.syncEnabled {
			return nil, centrifuge.ErrorMethodNotFound
		}
		var req struct {
			RoomID     string `json:"roomId"`
			TrackID    string `json:"trackId,omitempty"`
			PositionMs int64  `json:"positionMs"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		if req.RoomID == "" {
			return nil, fmt.Errorf("transport.play: roomId required")
		}
		if req.PositionMs < 0 {
			req.PositionMs = 0
		}
		return h.mutate(req.RoomID, func(s *queue.RoomState) error {
			if req.TrackID != "" {
				if err := s.SetNowPlaying(req.TrackID); err != nil {
					return err
				}
			}
			s.Transport = &queue.TransportState{
				State:             "playing",
				PositionMs:        req.PositionMs,
				UpdatedAtServerMs: time.Now().UnixMilli(),
			}
			s.Version++
			return nil
		})

	case "transport.pause":
		if !h.syncEnabled {
			return nil, centrifuge.ErrorMethodNotFound
		}
		var req struct {
			RoomID     string `json:"roomId"`
			PositionMs int64  `json:"positionMs"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		if req.RoomID == "" {
			return nil, fmt.Errorf("transport.pause: roomId required")
		}
		if req.PositionMs < 0 {
			req.PositionMs = 0
		}
		return h.mutate(req.RoomID, func(s *queue.RoomState) error {
			if s.Transport == nil {
				s.Transport = &queue.TransportState{}
			}
			s.Transport.State = "paused"
			s.Transport.PositionMs = req.PositionMs
			s.Transport.UpdatedAtServerMs = time.Now().UnixMilli()
			s.Version++
			return nil
		})

	case "transport.seek":
		if !h.syncEnabled {
			return nil, centrifuge.ErrorMethodNotFound
		}
		var req struct {
			RoomID     string `json:"roomId"`
			PositionMs int64  `json:"positionMs"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		if req.RoomID == "" {
			return nil, fmt.Errorf("transport.seek: roomId required")
		}
		if req.PositionMs < 0 {
			req.PositionMs = 0
		}
		return h.mutate(req.RoomID, func(s *queue.RoomState) error {
			if s.Transport == nil {
				s.Transport = &queue.TransportState{}
			}
			s.Transport.PositionMs = req.PositionMs
			s.Transport.UpdatedAtServerMs = time.Now().UnixMilli()
			s.Version++
			return nil
		})

	case "sync.ping":
		return json.Marshal(map[string]int64{"serverNowMs": time.Now().UnixMilli()})

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
	clientID := client.ID()
	userID := client.UserID()

	// Record the userID for host assignment (U3+).
	h.RecordClientUserID(clientID, userID)

	client.OnRPC(func(e centrifuge.RPCEvent, cb centrifuge.RPCCallback) {
		// Trust boundary: reject mutations of rooms this client hasn't joined.
		// Authorize has access to client.UserID() for authenticated requests.
		if err := h.Authorize(client, e.Method, e.Data); err != nil {
			cb(centrifuge.RPCReply{}, err)
			return
		}
		reply, err := h.handleRPC(e.Method, e.Data, userID, rateLimitKey(clientID, userID))
		cb(centrifuge.RPCReply{Data: reply}, rpcClientError(err))
	})
}

// rateLimitKey picks the bucket key for fanout RPCs: the authenticated userID
// when present, else the centrifuge clientID so anonymous clients are limited
// per connection rather than sharing one global bucket.
func rateLimitKey(clientID, userID string) string {
	if userID != "" {
		return "user:" + userID
	}
	return "client:" + clientID
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

// WithListenBrainzProvider enables track.listenbrainz RPC for enrichment data.
func (h *Hub) WithListenBrainzProvider(lbp ListenBrainzProvider) *Hub {
	h.listenBrainz = lbp
	return h
}

// WithLastfmEnrichProvider enables track.lastfm RPC for enrichment data.
func (h *Hub) WithLastfmEnrichProvider(lep LastfmEnrichProvider) *Hub {
	h.lastfmEnrich = lep
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
