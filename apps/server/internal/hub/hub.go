package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
	"github.com/LucasSantana-Dev/cojam/server/internal/playlist"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/rebind"
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

// maxImportTracks bounds client-supplied playlist imports (RFC-0007). 200 track
// refs at ~250 bytes of JSON each stay under centrifuge's default 64 KiB message
// limit; a larger frame would drop the websocket instead of returning an error.
const maxImportTracks = 200

// maxImportFieldLen caps free-text fields coming from clients.
const maxImportFieldLen = 300

// maxSearchQueryLen caps track.search queries forwarded to upstream providers
// (Deezer/Spotify); longer is a client bug and rejected before any fanout.
const maxSearchQueryLen = 200

// maxSearchPrefer caps the track.search prefer list to the provider allowlist
// size (match.providerAllowlist: spotify, deezer, apple); extras are truncated.
const maxSearchPrefer = 3

// maxImportDurationMs bounds track duration (2 hours); longer is a client bug.
const maxImportDurationMs = 2 * 60 * 60 * 1000

// maxArtworkURLLen caps client-supplied artwork URLs. Provider CDN URLs are
// well under this; longer is a client bug or an attempt to bloat RoomState.
const maxArtworkURLLen = 512

// maxRoomNameLen caps the host-set public room label (room.set_public), in
// chars. 60 keeps directory cards to a single line.
const maxRoomNameLen = 60

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
		if len(t.AddedBy) > maxImportFieldLen {
			return userErrorf("track %d: addedBy too long", i+1)
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
		// Artwork is rendered as <img src> by every client: https only, so a
		// client-supplied URL can never become a javascript:/data: vector.
		if len(t.ArtworkURL) > maxArtworkURLLen {
			return userErrorf("track %d: artwork url too long", i+1)
		}
		if t.ArtworkURL != "" && !strings.HasPrefix(t.ArtworkURL, "https://") {
			return userErrorf("track %d: artwork url must be https", i+1)
		}
		// Kind drives client rendering, so an unrecognised value would leave a
		// track that no player claims. Empty stays valid and means audio.
		if t.Kind != "" && t.Kind != queue.KindAudio && t.Kind != queue.KindVideo {
			return userErrorf("track %d: unknown kind", i+1)
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

// mapQueueErr converts queue sentinel errors into client-visible UserErrors
// (code 400 via rpcClientError), the same mapping queue.vote applies inline:
// routine mistakes (unknown track) must not be masked as code 100 internal
// server errors.
func mapQueueErr(err error) error {
	if errors.Is(err, queue.ErrTrackNotFound) {
		return userErrorf("track not found")
	}
	return err
}

// rpcMetricStatus classifies an RPC outcome for the duration histogram:
// user mistakes (UserError) get their own label so the "error" label counts
// only server faults.
func rpcMetricStatus(err error) string {
	if err == nil {
		return "ok"
	}
	var ue *UserError
	if errors.As(err, &ue) {
		return "user_error"
	}
	return "error"
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

	// chat is the room's ephemeral message ring (F8), guarded by mu. Never in
	// RoomState and never persisted: appends skip the mutate path entirely, so
	// no Version bump and no store.Save per message.
	chat []ChatMessage

	// lastActivityUnix is the last time the room was touched (GetOrCreateRoom
	// hit or create), as Unix nanos. The idle-room evictor only reaps rooms
	// whose activity is older than the TTL. Atomic: reads and writes happen
	// under different locks (h.mu, room.mu) depending on the caller.
	lastActivityUnix atomic.Int64

	// sharedObserved flips once, the first time the room reaches two concurrent
	// members — the first non-creator member under the link-is-capability trust
	// model (#180); Join emits the log/metric on the flip. The flag dies with
	// the room on idle eviction, so a re-loaded room may emit again.
	sharedObserved atomic.Bool
}

// touch marks the room active now, resetting the idle-eviction clock.
func (r *Room) touch() {
	r.lastActivityUnix.Store(time.Now().UnixNano())
}

// lastActivity returns when the room was last touched.
func (r *Room) lastActivity() time.Time {
	return time.Unix(0, r.lastActivityUnix.Load())
}

// Hub manages all rooms
type Hub struct {
	mu              sync.RWMutex
	rooms           map[string]*Room
	store           store.Store
	node            *centrifuge.Node
	publishFn       func(roomID string, state json.RawMessage) error // test seam; nil = publish via node
	logger          *slog.Logger
	moderationAudit ModerationAudit
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
	votingEnabled   bool
	chatEnabled     bool

	// publicRoomsEnabled gates the public room directory RPCs
	// (room.set_public, room.list; FEATURE_PUBLIC_ROOMS). Dark-shipped off:
	// when false both RPCs return ErrorMethodNotFound (transport.* precedent).
	publicRoomsEnabled bool

	// roomIdleTTL is how long a room with no connected members may stay idle
	// before StartRoomEvictor's sweep drops it from memory. <= 0 disables
	// eviction. State survives in the store and reloads on rejoin.
	roomIdleTTL time.Duration

	// roomPersistIdleTTL is how long a stored room row may stay memberless
	// and untouched before StartRoomEvictor's sweep deletes it (#169). <= 0
	// disables persistent eviction. Independent of roomIdleTTL: the
	// in-memory sweep answers "should this room stay resident", the
	// persistent one "should this row still exist".
	roomPersistIdleTTL time.Duration

	// fanoutLimiter rate-limits RPCs that fan out to third-party APIs
	// (fanoutMethods) per caller, protecting upstream provider quotas.
	fanoutLimiter *rateLimiter

	// voteLimiter rate-limits queue.vote per caller (voteMethods): each toggle
	// fans out a full-state publication to the room, so toggle wars are
	// throttled. Separate from fanoutLimiter, whose budget protects
	// third-party API quotas; votes never leave the server.
	voteLimiter *rateLimiter

	// chatLimiter rate-limits chat.send per caller (chatMethods): chat is the
	// canonical spammable RPC, and a per-caller bucket keeps one spammer from
	// throttling the room. The host moderation RPCs (chat.delete, room.kick,
	// #181) share the bucket.
	chatLimiter *rateLimiter

	// listLimiter rate-limits the room.list directory read per caller. It is
	// an unauthenticated read that landing visitors poll, so it gets its own
	// bucket (no third-party fanout, hence not in fanoutMethods).
	listLimiter *rateLimiter

	// enrichSem bounds concurrent outbound matcher lookups. Bulk imports can add
	// up to 200 tracks at once; an unbounded goroutine per track would burst
	// hundreds of simultaneous YouTube/Spotify requests and trip rate limits.
	enrichSem chan struct{}

	// enrichPending bounds total enrich goroutines (live + parked on
	// enrichSem). Without it the semaphore caps live lookups but not spawned
	// goroutines, so import spam parks hundreds of waiters that enrich
	// long-since-removed tracks. Jobs arriving when pending is full are
	// dropped (and logged) instead.
	enrichPending chan struct{}

	// members gates mutating RPCs: a client may only mutate rooms it has joined
	// (via room.join) or subscribed to. Populated on join/subscribe, cleared on
	// disconnect. Separate mutex from rooms to avoid contention.
	// roomMembers is the same index inverted (roomID -> set of clientIDs),
	// maintained by Join/Leave so member counts and room-scoped lookups are
	// O(1)/O(room members) instead of scanning every connected client (#197).
	memberMu    sync.RWMutex
	members     map[string]map[string]struct{} // clientID -> set of roomIDs
	roomMembers map[string]map[string]struct{} // roomID -> set of clientIDs

	// memberJoinTimes records when each identified userID most recently joined
	// each room, for longest-present promotion on host disconnect (#166).
	// Connections with an empty userID are not tracked; that only happens when
	// FEATURE_ROOM_AUTH is off, where no one can hold the host role. Under
	// room auth, anonymous subs are non-empty, so guests are tracked too (and
	// can hold the host role). Guarded by memberMu.
	memberJoinTimes map[string]map[string]int64 // roomID -> userID -> unix nanos

	// clientUserID tracks the authenticated userID per clientID for host
	// assignment (U3+); clientName tracks the display name the connection
	// presented at connect time (ConnInfo {name}). Together they are the
	// server-owned connection identity (#165): queue attribution is stamped
	// from them, never trusted from RPC params. Both populated on
	// RegisterClient, both cleared on disconnect.
	clientUserIDMu sync.RWMutex
	clientUserID   map[string]string // clientID -> userID
	clientName     map[string]string // clientID -> connect-time display name

	// rebindSecret verifies the anonymous connection JWT presented to
	// room.rebind as proof of guest ownership (#172); rebindBurns records
	// consumed anonymous subs so a proof is single-use. Both nil when
	// FEATURE_ROOM_AUTH is off: the RPC then replies ErrorMethodNotFound.
	rebindSecret []byte
	rebindBurns  rebind.BurnList
}

// mutatingMethods are the membership-gated RPCs: the caller must be a member
// of the target room. Most change room state; chat.send/chat.history do not
// (chat is ephemeral, never in RoomState) but need the same membership gate.
// room.join enrolls (see Authorize); reads and unknown methods fall through
// to dispatch.
var mutatingMethods = map[string]bool{
	"queue.add":           true,
	"queue.remove":        true,
	"queue.reorder":       true,
	"queue.vote":          true,
	"now_playing.set":     true,
	"now_playing.advance": true,
	"playlist.import":     true,
	"radio.set":           true,
	"room.set_public":     true,
	"room.kick":           true,
	"room.rebind":         true,
	"transport.play":      true,
	"transport.pause":     true,
	"transport.seek":      true,
	"chat.send":           true,
	"chat.history":        true,
	"chat.delete":         true,
}

// hostOnlyMethods are mutating RPCs that disrupt room control and therefore
// require the caller to be the room's host (RFC-0005 U4).
// queue.add and room.join are always allowed for members.
// queue.remove is host-gated with one exception: the track's owner
// (TrackRef.AddedByUserID) may remove it (B16), enforced in Authorize.
var hostOnlyMethods = map[string]bool{
	"now_playing.set":     true,
	"now_playing.advance": true,
	"queue.reorder":       true,
	"queue.remove":        true,
	"radio.set":           true,
	"playlist.import":     true,
	"room.set_public":     true,
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

// WithVoting enables queue voting (queue.vote, F4). Deliberately member-gated,
// never host-only: voting is the listener's input channel.
func (h *Hub) WithVoting(enabled bool) *Hub {
	h.votingEnabled = enabled
	return h
}

// WithChat enables ephemeral room chat RPCs (chat.send/chat.history, F8).
// Off returns ErrorMethodNotFound, same as transport.* (dark-ship default).
// ModerationAudit records a completed moderation action. A func rather than an
// interface so hub does not import the storage package. Nil disables auditing.
type ModerationAudit func(action, roomID, actorUserID, subjectID string)

// WithModerationAudit wires the audit sink for chat.delete and room.kick (#259).
func (h *Hub) WithModerationAudit(fn ModerationAudit) *Hub {
	h.moderationAudit = fn
	return h
}

func (h *Hub) WithChat(enabled bool) *Hub {
	h.chatEnabled = enabled
	return h
}

// WithPublicRooms enables the public room directory RPCs (room.set_public,
// room.list). Default off (dark-ship, same posture as WithSync).
func (h *Hub) WithPublicRooms(enabled bool) *Hub {
	h.publicRoomsEnabled = enabled
	return h
}

// WithRebind enables the room.rebind RPC (guest-to-account upgrade, #172):
// secret verifies the anonymous connection JWT presented as the ownership
// proof, burns records consumed anonymous subs so a proof is single-use.
func (h *Hub) WithRebind(secret []byte, burns rebind.BurnList) *Hub {
	h.rebindSecret = secret
	h.rebindBurns = burns
	return h
}

// NewHub creates a new hub with the given centrifuge node (nil in tests: publish is skipped).
// Defaults to an in-memory store; use WithStore to inject a different implementation.
func NewHub(node *centrifuge.Node) *Hub {
	return &Hub{
		rooms:           make(map[string]*Room),
		store:           store.NewMemory(),
		node:            node,
		members:         make(map[string]map[string]struct{}),
		roomMembers:     make(map[string]map[string]struct{}),
		memberJoinTimes: make(map[string]map[string]int64),
		clientUserID:    make(map[string]string),
		clientName:      make(map[string]string),
		enrichSem:       make(chan struct{}, enrichConcurrency),
		enrichPending:   make(chan struct{}, enrichMaxPending),
		fanoutLimiter:   newRateLimiter(fanoutBurst, fanoutRefill, time.Now),
		voteLimiter:     newRateLimiter(voteBurst, voteRefill, time.Now),
		chatLimiter:     newRateLimiter(chatBurst, chatRefill, time.Now),
		listLimiter:     newRateLimiter(listBurst, listRefill, time.Now),
	}
}

const (
	// enrichConcurrency caps live outbound matcher lookups.
	enrichConcurrency = 8
	// enrichMaxPending caps total enrich goroutines (live + parked on
	// enrichSem). A 200-track import otherwise parks 2 goroutines per track
	// with no timeout on the wait; beyond this bound jobs are dropped, not
	// queued.
	enrichMaxPending = 32
)

// launchEnrich runs fn in a goroutine gated by enrichSem so bulk imports cannot
// fire unbounded concurrent matcher lookups. Admission is bounded and
// non-blocking: when enrichPending is full the job is dropped and logged
// rather than parking another goroutine (#196).
func (h *Hub) launchEnrich(fn func()) {
	select {
	case h.enrichPending <- struct{}{}:
	default:
		if h.logger != nil {
			h.logger.Info("enrich_dropped", "reason", "pending_full")
		}
		return
	}
	go func() {
		defer func() { <-h.enrichPending }()
		h.enrichSem <- struct{}{}
		defer func() { <-h.enrichSem }()
		fn()
	}()
}

// Join enrolls a client as a member of a room (called on room.join and on
// channel subscribe, so membership survives centrifuge reconnects). Also
// stamps the join time for authenticated members here, not only in room.join:
// a client that subscribes without sending room.join would otherwise have a
// zero join time and selectSuccessor would treat it as the oldest member.
// A rejoin resets the timestamp: seniority measures continuous presence.
// When the room reaches two concurrent members for the first time, Join emits
// the first-non-creator-member signal (structured log + metric, #180). A
// brand-new enrollment also announces the join in chat (#205); the
// announcement runs after memberMu is released (announcements take
// h.mu/room.mu, which nest the other way).
func (h *Hub) Join(clientID, roomID string) {
	if clientID == "" || roomID == "" {
		return
	}
	h.memberMu.Lock()
	_, alreadyMember := h.members[clientID][roomID]
	if h.members[clientID] == nil {
		h.members[clientID] = make(map[string]struct{})
	}
	h.members[clientID][roomID] = struct{}{}
	if h.roomMembers[roomID] == nil {
		h.roomMembers[roomID] = make(map[string]struct{})
	}
	h.roomMembers[roomID][clientID] = struct{}{}

	h.clientUserIDMu.RLock()
	userID := h.clientUserID[clientID]
	h.clientUserIDMu.RUnlock()
	if userID != "" {
		if h.memberJoinTimes[roomID] == nil {
			h.memberJoinTimes[roomID] = make(map[string]int64)
		}
		h.memberJoinTimes[roomID][userID] = time.Now().UnixNano()
	}
	memberCount := len(h.roomMembers[roomID])
	h.memberMu.Unlock()

	if memberCount >= 2 {
		h.observeFirstShared(roomID)
	}
	if !alreadyMember {
		h.announceMembership(roomID, h.displayName(clientID), "joined")
	}
}

// observeFirstShared emits the "room became shared" signal exactly once per
// room instance: the first time a second concurrent member joins (the first
// non-creator member under the link-is-capability trust model, #180). The flag
// lives on the Room, so it survives member churn but resets if the room is
// evicted and re-loaded. Nil-safe when observability is not wired (tests).
func (h *Hub) observeFirstShared(roomID string) {
	h.mu.RLock()
	room, exists := h.rooms[roomID]
	h.mu.RUnlock()
	if !exists {
		return // room not loaded yet; the room.join Join re-fires the check
	}
	if !room.sharedObserved.CompareAndSwap(false, true) {
		return
	}
	if h.logger != nil {
		h.logger.Info("room_first_non_creator_member", "room_id", roomID)
	}
	if h.metrics != nil {
		h.metrics.RoomShared()
	}
}

// Leave drops all of a client's memberships (called on disconnect) and
// announces the departure in each room's chat (#205). Runs before
// RemoveClientUserID on the disconnect path, so the display name is still
// available here.
func (h *Hub) Leave(clientID string) {
	h.memberMu.Lock()
	rooms := make([]string, 0, len(h.members[clientID]))
	for roomID := range h.members[clientID] {
		delete(h.roomMembers[roomID], clientID)
		if len(h.roomMembers[roomID]) == 0 {
			delete(h.roomMembers, roomID)
		}
		rooms = append(rooms, roomID)
	}
	delete(h.members, clientID)
	h.memberMu.Unlock()

	if len(rooms) > 0 {
		name := h.displayName(clientID)
		for _, roomID := range rooms {
			h.announceMembership(roomID, name, "left")
		}
	}
}

// leaveRoom drops one client's membership in one room (room.kick, #181);
// Leave drops every membership at disconnect. Idempotent: unknown pairs are
// no-ops. The kicked client's own disconnect still runs Leave afterwards.
func (h *Hub) leaveRoom(clientID, roomID string) {
	h.memberMu.Lock()
	defer h.memberMu.Unlock()
	delete(h.members[clientID], roomID)
	if len(h.members[clientID]) == 0 {
		delete(h.members, clientID)
	}
	delete(h.roomMembers[roomID], clientID)
	if len(h.roomMembers[roomID]) == 0 {
		delete(h.roomMembers, roomID)
	}
}

// PruneGuestVotes removes the disconnecting guest's voter key from every room
// the client is enrolled in (called on disconnect, before Leave clears the
// membership list and before RemoveClientUserID drops the identity). A
// guest's votes die with the connection: neither the clientID nor the
// anonymous room-auth sub is ever reused, so keeping the keys would inflate
// counts and let a reconnecting guest double-vote (#183, #232). The key
// pruned is the same one rateLimitKey resolves for the vote RPC:
// "user:<anonSub>" when the connection carried an anonymous room-auth
// identity, else "client:<clientID>". Authenticated "sb:<uuid>" identities
// survive reconnects, so their votes are deliberately kept. Ordering vs.
// room.rebind (#172): if the guest rebound first, their votes were already
// rewritten to "user:<sb:...>" and the prune of the dead anonymous key is a
// no-op; if the disconnect fires first, the prune removes the votes and a
// later rebind finds nothing to claim — either way, votes tied to the
// anonymous identity die with the disconnect unless a rebind already claimed
// them. Each prune goes through mutate, so a room where the client actually
// voted gets a Version bump + save + publish; rooms where it never voted are
// untouched.
func (h *Hub) PruneGuestVotes(clientID string) {
	if clientID == "" {
		return
	}
	h.clientUserIDMu.RLock()
	userID := h.clientUserID[clientID]
	h.clientUserIDMu.RUnlock()
	if strings.HasPrefix(userID, "sb:") {
		return
	}

	h.memberMu.RLock()
	rooms := make([]string, 0, len(h.members[clientID]))
	for roomID := range h.members[clientID] {
		rooms = append(rooms, roomID)
	}
	h.memberMu.RUnlock()

	voterKey := rateLimitKey(clientID, userID)
	for _, roomID := range rooms {
		if _, err := h.mutate(roomID, func(s *queue.RoomState) error {
			s.PruneVoter(voterKey)
			return nil
		}); err != nil && h.logger != nil {
			h.logger.Info("guest_votes_prune_failed", "room_id", roomID, "err", err.Error())
		}
	}
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

// RecordClientName tracks the display name a connection presented at connect
// time (called from RegisterClient with the ConnInfo name). The server stamps
// it as TrackRef.AddedBy on queue.add/playlist.import (#165), so a crafted
// RPC cannot attribute tracks to another member's name.
func (h *Hub) RecordClientName(clientID, name string) {
	if clientID == "" {
		return
	}
	h.clientUserIDMu.Lock()
	defer h.clientUserIDMu.Unlock()
	if name != "" {
		h.clientName[clientID] = name
	}
}

// displayName returns the connect-time display name recorded for a
// connection, or "" when none was presented (or the caller is
// transport-independent, e.g. tests calling HandleRPC).
func (h *Hub) displayName(clientID string) string {
	h.clientUserIDMu.RLock()
	defer h.clientUserIDMu.RUnlock()
	return h.clientName[clientID]
}

// RemoveClientUserID removes the identity tracking (userID and display name)
// for a client (called on disconnect).
func (h *Hub) RemoveClientUserID(clientID string) {
	h.clientUserIDMu.Lock()
	defer h.clientUserIDMu.Unlock()
	delete(h.clientUserID, clientID)
	delete(h.clientName, clientID)
}

// recordJoinTime stamps when an authenticated userID joined a room, for
// longest-present host promotion (#166). A rejoin resets the timestamp:
// seniority measures continuous presence, not cumulative history.
func (h *Hub) recordJoinTime(roomID, userID string) {
	if roomID == "" || userID == "" {
		return
	}
	h.memberMu.Lock()
	defer h.memberMu.Unlock()
	if h.memberJoinTimes[roomID] == nil {
		h.memberJoinTimes[roomID] = make(map[string]int64)
	}
	h.memberJoinTimes[roomID][userID] = time.Now().UnixNano()
}

// PromoteOnDisconnect promotes a new host in every room where the
// disconnecting client held the host role (#166). Must be called BEFORE
// h.Leave and h.RemoveClientUserID: it needs the departing client's userID
// and room memberships, which those calls destroy. No-op for guests and for
// clients that held no host role.
func (h *Hub) PromoteOnDisconnect(clientID string) {
	h.clientUserIDMu.RLock()
	userID := h.clientUserID[clientID]
	h.clientUserIDMu.RUnlock()
	if userID == "" {
		return // no identity to match against HostUserID; empty userIDs only occur with FEATURE_ROOM_AUTH off, where guests cannot hold the host role
	}

	h.memberMu.RLock()
	roomIDs := make([]string, 0, len(h.members[clientID]))
	for roomID := range h.members[clientID] {
		roomIDs = append(roomIDs, roomID)
	}
	h.memberMu.RUnlock()

	for _, roomID := range roomIDs {
		h.promoteInRoom(roomID, clientID, userID)
	}
}

// promoteInRoom runs the host handoff for one room where the departing
// userID held the host role: the longest-present remaining authenticated
// member becomes host, or an all-guest room's HostUserID is cleared. The
// common case (departing client was not this room's host) is a cheap read
// and returns early.
func (h *Hub) promoteInRoom(roomID, clientID, userID string) {
	if h.GetHostUserID(roomID) != userID {
		return
	}
	successor, others := h.selectSuccessor(roomID, clientID)
	if !others {
		return // empty room: nothing to promote; evictIdleRooms reaps it
	}
	h.commitHostHandoff(roomID, userID, successor)
}

// selectSuccessor picks the longest-present remaining authenticated member
// of roomID, excluding the departing clientID. others reports whether any
// other member (guest or authenticated) remains at all. The departing client
// is excluded explicitly: PromoteOnDisconnect runs before h.Leave, so it
// still holds membership. memberMu is held for the membership and join-time
// reads and released before the caller mutates, keeping the evictor's lock
// ordering (memberMu then h.mu/room.mu) intact.
func (h *Hub) selectSuccessor(roomID, clientID string) (successor string, others bool) {
	h.memberMu.RLock()
	defer h.memberMu.RUnlock()
	h.clientUserIDMu.RLock()
	defer h.clientUserIDMu.RUnlock()
	var successorJoin int64
	for memberClientID, rooms := range h.members {
		if memberClientID == clientID {
			continue
		}
		if _, inRoom := rooms[roomID]; !inRoom {
			continue
		}
		others = true
		memberUserID := h.clientUserID[memberClientID]
		if memberUserID == "" {
			continue // guests are not eligible for the host role (RFC-0005)
		}
		if join := h.memberJoinTimes[roomID][memberUserID]; successor == "" || join < successorJoin {
			successor = memberUserID
			successorJoin = join
		}
	}
	return successor, others
}

// commitHostHandoff applies the promotion through the standard mutate path,
// so the Version bump and publish follow the established convention. The
// closure re-checks that HostUserID still equals the departing userID (a
// concurrent promotion wins and must not be overwritten) and revalidates the
// successor at commit time: if the candidate disconnected or lost its
// authenticated identity between selection and mutation, the closure aborts
// without mutating — the next join's lazy reclaim runs the promotion again,
// so a departed user is never persisted as host. An empty successor means an
// all-guest room: HostUserID is cleared, restoring equal-member behavior.
func (h *Hub) commitHostHandoff(roomID, userID, successor string) {
	if _, err := h.mutate(roomID, func(s *queue.RoomState) error {
		if s.HostUserID != userID {
			return nil // a concurrent promotion already applied
		}
		if successor == "" {
			s.HostUserID = ""
			s.Version++
			return nil
		}
		if !h.IsUserIDInRoom(roomID, successor) {
			return nil // successor departed between selection and commit
		}
		s.HostUserID = successor
		s.Version++
		return nil
	}); err != nil && h.logger != nil {
		h.logger.Error("host_handoff_failed", "room_id", roomID, "err", err.Error())
	}
}

// IsUserIDInRoom checks if a given userID has an active member in the room.
// Scans only the room's own members via the inverted index, not every
// connected client (#197).
func (h *Hub) IsUserIDInRoom(roomID, userID string) bool {
	if userID == "" {
		return false
	}
	h.memberMu.RLock()
	defer h.memberMu.RUnlock()

	h.clientUserIDMu.RLock()
	defer h.clientUserIDMu.RUnlock()

	for clientID := range h.roomMembers[roomID] {
		if h.clientUserID[clientID] == userID {
			return true
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
		RoomID  string `json:"roomId"`
		TrackID string `json:"trackId"`
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
			// B16 (RFC-0005): a listener may remove a track they added.
			if method == "queue.remove" && h.isTrackOwner(probe.RoomID, probe.TrackID, userID) {
				return nil
			}
			return centrifuge.ErrorPermissionDenied
		}
	}

	return nil
}

// isTrackOwner reports whether userID queued trackID in roomID
// (TrackRef.AddedByUserID, populated server-side on queue.add). Tracks added
// before B16 or while FEATURE_ROOM_AUTH is off carry no owner and stay
// host-only. Read-only: never creates a room.
func (h *Hub) isTrackOwner(roomID, trackID, userID string) bool {
	if userID == "" {
		return false
	}
	h.mu.RLock()
	room, exists := h.rooms[roomID]
	h.mu.RUnlock()
	if !exists {
		return false
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	for _, t := range room.State.Queue {
		if t.ID == trackID {
			return t.AddedByUserID != "" && t.AddedByUserID == userID
		}
	}
	return false
}

// GetOrCreateRoom retrieves or creates a room, with read-through to the store.
// If the room is not in the map, Load from store. On ErrNotFound, create a fresh room
// and persist it. Any other Load error is treated as transient (DB hiccup): the call
// fails with a retryable error instead of forking the room at version 0 (#194) — a
// fresh v0 room's saves would be silently dropped by the store's version-guarded
// upsert until the in-memory version overtook the stored one, diverging live state
// from persistence.
//
// The store IO runs outside h.mu (never hold the global lock across IO), so
// concurrent creators for the same roomID race: the final insert re-checks
// under a single lock and the loser discards its instance. Every caller must
// share one *Room per roomID; a losing caller keeping its own instance would
// split room.mu and orphan its mutations (never published, never persisted).
func (h *Hub) GetOrCreateRoom(roomID string) (*Room, error) {
	h.mu.Lock()
	if room, exists := h.rooms[roomID]; exists {
		room.touch()
		h.mu.Unlock()
		return room, nil
	}
	h.mu.Unlock()

	// Try to load from store (bounded: a hung store must not wedge the hub)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	state, err := h.store.Load(ctx, roomID)

	if err != nil && !errors.Is(err, store.ErrNotFound) {
		if h.logger != nil {
			h.logger.Error("store_load_failed", "room_id", roomID, "err", err.Error())
		}
		if h.metrics != nil {
			h.metrics.StoreError("load")
		}
		return nil, userErrorf("could not load the room, please retry")
	}

	// If not found, create fresh
	if state == nil {
		state = &queue.RoomState{
			RoomID:    roomID,
			Queue:     []queue.TrackRef{},
			Version:   0,
			CreatedAt: time.Now().UnixMilli(),
		}

		// Persist the fresh room
		if err := h.store.Save(ctx, state); err != nil {
			if h.logger != nil {
				h.logger.Error("store_save_failed", "room_id", roomID, "err", err.Error())
			}
			if h.metrics != nil {
				h.metrics.StoreError("save")
			}
		}
	}

	// Double-checked insert: another goroutine may have won while we were
	// doing store IO outside the lock. Prefer the existing instance.
	h.mu.Lock()
	defer h.mu.Unlock()
	if room, exists := h.rooms[roomID]; exists {
		room.touch()
		return room, nil
	}
	room := &Room{State: state}
	room.touch()
	h.rooms[roomID] = room
	return room, nil
}

// WithRoomIdleTTL sets how long a room with no connected members may stay
// idle before the evictor drops it from memory (default: disabled). The store
// keeps the room state, so an evicted room reloads transparently on the next
// GetOrCreateRoom. <= 0 disables eviction.
func (h *Hub) WithRoomIdleTTL(d time.Duration) *Hub {
	h.roomIdleTTL = d
	return h
}

// WithRoomPersistIdleTTL sets how long a stored room row may stay memberless
// and untouched before the evictor deletes it from the store (default:
// disabled, #169). Expected to be much longer than the in-memory TTL. <= 0
// disables persistent eviction.
func (h *Hub) WithRoomPersistIdleTTL(d time.Duration) *Hub {
	h.roomPersistIdleTTL = d
	return h
}

// StartRoomEvictor launches the periodic idle-room sweeps (in-memory and
// persistent) and returns a stop function for shutdown. One ticker, one
// shutdown path: the persistent sweep extends the existing loop rather than
// running a second scheduler (#169). A hub with both TTLs disabled gets a
// no-op stop.
func (h *Hub) StartRoomEvictor() func() {
	ttl := h.roomIdleTTL
	if ttl <= 0 || (h.roomPersistIdleTTL > 0 && h.roomPersistIdleTTL < ttl) {
		ttl = h.roomPersistIdleTTL
	}
	if ttl <= 0 {
		return func() {}
	}
	interval := ttl / 2
	if interval < time.Second {
		interval = time.Second
	}
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case now := <-ticker.C:
				h.evictIdleRooms(now)
				h.evictPersistedIdleRooms(now)
			}
		}
	}()
	return func() { close(stop) }
}

// evictIdleRooms drops rooms with no connected members that have been idle
// longer than roomIdleTTL. Only the in-memory instance is removed: the store
// keeps the state and GetOrCreateRoom reloads it on rejoin. The room's
// memberJoinTimes entry dies with it, so the two lifetimes stay identical
// and the map cannot leak. Lock order is memberMu then h.mu (the only spot
// that nests them); Join/Leave take memberMu alone and GetOrCreateRoom takes
// h.mu alone, so no cycle forms.
func (h *Hub) evictIdleRooms(now time.Time) {
	if h.roomIdleTTL <= 0 {
		return
	}
	h.memberMu.Lock()
	defer h.memberMu.Unlock()
	h.mu.Lock()
	defer h.mu.Unlock()
	for roomID, room := range h.rooms {
		if h.hasMembersLocked(roomID) {
			continue
		}
		if now.Sub(room.lastActivity()) < h.roomIdleTTL {
			continue
		}
		delete(h.rooms, roomID)
		delete(h.memberJoinTimes, roomID)
		if h.logger != nil {
			h.logger.Info("room_evicted", "room_id", roomID)
		}
		if h.metrics != nil {
			h.metrics.RoomEvicted()
		}
	}
}

// evictPersistedIdleRooms deletes store rows for rooms that have been
// memberless and untouched past roomPersistIdleTTL (#169). The sweep is
// membership-gated, not timestamp-gated alone: rooms with connected members
// are passed to the store as protected and skipped however old their rows
// are. A store failure logs and returns without aborting the tick; the next
// tick retries. Time is injected so tests need no ticker and no sleep.
func (h *Hub) evictPersistedIdleRooms(now time.Time) {
	if h.roomPersistIdleTTL <= 0 {
		return
	}
	h.memberMu.RLock()
	protected := make(map[string]struct{})
	for _, rooms := range h.members {
		for roomID := range rooms {
			protected[roomID] = struct{}{}
		}
	}
	h.memberMu.RUnlock()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cutoff := now.Add(-h.roomPersistIdleTTL)
	removed, err := h.store.DeleteIdleRooms(ctx, cutoff, protected)
	if err != nil {
		if h.logger != nil {
			h.logger.Error("room_persist_evict_failed", "err", err.Error(), "cutoff", cutoff.UTC(), "ttl", h.roomPersistIdleTTL.String())
		}
		return
	}
	if removed > 0 {
		if h.logger != nil {
			h.logger.Info("room_persist_evicted", "removed", removed, "cutoff", cutoff.UTC(), "ttl", h.roomPersistIdleTTL.String(), "protected", len(protected))
		}
		if h.metrics != nil {
			h.metrics.RoomPersistedEvicted(removed)
		}
	}
}

// hasMembersLocked reports whether any client holds a membership in roomID.
// Callers must hold memberMu.
func (h *Hub) hasMembersLocked(roomID string) bool {
	return len(h.roomMembers[roomID]) > 0
}

// mutate applies fn to the room under its lock, marshals the resulting state while
// still holding the lock (state is a pointer; marshaling outside would race), releases
// the lock, then persists to the store and publishes the snapshot to the room channel.
// When fn leaves Version unchanged the mutation was a no-op (every state change bumps
// Version, and version-guarded clients would reject an unbumped publication anyway),
// so the save + broadcast are skipped. The state is deep-copied before releasing the
// lock to prevent data races. Store errors are logged but non-fatal to the result,
// and a publish failure post-commit is logged + counted but still returns the new
// state (#178): the mutation already succeeded, so an RPC error would invite a
// retry that duplicates it.
func (h *Hub) mutate(roomID string, fn func(*queue.RoomState) error) (json.RawMessage, error) {
	room, err := h.GetOrCreateRoom(roomID)
	if err != nil {
		return nil, err
	}

	room.mu.Lock()
	versionBefore := room.State.Version
	if fn != nil {
		if err := fn(room.State); err != nil {
			room.mu.Unlock()
			return nil, err
		}
	}
	changed := room.State.Version != versionBefore
	data, err := json.Marshal(room.State)
	room.mu.Unlock()
	if err != nil {
		return nil, err
	}

	if fn != nil && changed {
		// Write-through: persist state after releasing room lock.
		// Unmarshal the JSON to get a deep copy safe for store.Save.
		var stateCopy queue.RoomState
		if err := json.Unmarshal(data, &stateCopy); err != nil {
			if h.logger != nil {
				h.logger.Error("store_marshal_failed", "room_id", roomID, "err", err.Error())
			}
		} else {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := h.store.Save(ctx, &stateCopy); err != nil {
				if h.logger != nil {
					h.logger.Error("store_save_failed", "room_id", roomID, "err", err.Error())
				}
				if h.metrics != nil {
					h.metrics.StoreError("save")
				}
			}
		}

		// Publish to room channel. Post-commit (#178): the mutation is already
		// applied and persisted, so a failed broadcast must NOT surface as the
		// RPC error — clients would retry and duplicate the mutation. Log +
		// metric; the RPC still returns the new state.
		if err := h.publish(roomID, data); err != nil {
			if h.logger != nil {
				h.logger.Error("publish_failed", "room_id", roomID, "err", err.Error())
			}
			if h.metrics != nil {
				h.metrics.PublishError()
			}
		}
	}
	return data, nil
}

func (h *Hub) publish(roomID string, state json.RawMessage) error {
	if h.publishFn != nil { // test seam
		return h.publishFn(roomID, state)
	}
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
	return h.handleRPC(method, data, "", userID)
}

// handleRPC is HandleRPC with the transport-known clientID. The transport
// layer passes it so anonymous clients are rate-limited per connection
// instead of sharing one bucket, and so display-name attribution can be
// stamped from the connection identity (#165). The derived rate-limit key
// doubles as the queue.vote voter identity: it is exactly "user:<userID>"
// when authenticated, else "client:<clientID>", so the server stamps identity
// and clients never send who they are.
func (h *Hub) handleRPC(method string, data []byte, clientID, userID string) (json.RawMessage, error) {
	rlKey := rateLimitKey(clientID, userID)
	start := time.Now()
	// Fanout RPCs are rate-limited per caller before doing any work; a
	// rejection surfaces as a UserError (centrifuge code 400) via
	// rpcClientError and does not touch other methods' budgets. Vote RPCs get
	// their own bucket (each toggle republishes the full room state), and the
	// room.list directory read gets its own (listMethods): no third-party
	// fanout, but landing visitors poll it unauthenticated.
	var result json.RawMessage
	err := h.checkFanoutLimit(method, rlKey)
	if err == nil {
		err = h.checkVoteLimit(method, rlKey)
	}
	if err == nil {
		err = h.checkChatLimit(method, rlKey)
	}
	if err == nil {
		err = h.checkListLimit(method, rlKey)
	}
	if err == nil {
		result, err = h.dispatch(method, data, clientID, userID, rlKey)
	}
	d := time.Since(start)

	if h.metrics != nil {
		h.metrics.ObserveRPC(method, rpcMetricStatus(err), d)
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
		if h.metrics != nil {
			h.metrics.RateLimitReject(method)
		}
		return userErrorf("too many requests, slow down")
	}
	return nil
}

// checkVoteLimit enforces the per-caller token bucket on queue.vote. Returns
// nil for unlimited methods.
func (h *Hub) checkVoteLimit(method, rlKey string) error {
	if !voteMethods[method] || h.voteLimiter == nil {
		return nil
	}
	if !h.voteLimiter.allow(rlKey) {
		if h.metrics != nil {
			h.metrics.RateLimitReject(method)
		}
		return userErrorf("too many requests, slow down")
	}
	return nil
}

// checkListLimit enforces the per-caller token bucket on the room.list
// directory read. Returns nil for unlimited methods.
func (h *Hub) checkListLimit(method, rlKey string) error {
	if !listMethods[method] || h.listLimiter == nil {
		return nil
	}
	if !h.listLimiter.allow(rlKey) {
		if h.metrics != nil {
			h.metrics.RateLimitReject(method)
		}
		return userErrorf("too many requests, slow down")
	}
	return nil
}

func (h *Hub) dispatch(method string, data []byte, clientID, userID, rlKey string) (json.RawMessage, error) {
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
		// Stamp presence for longest-present host promotion (#166); a rejoin
		// resets seniority by design.
		h.recordJoinTime(req.RoomID, userID)
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
		// queue.add crosses the same trust boundary as playlist.import's
		// client-supplied tracks (RFC-0007): the TrackRef is arbitrary client
		// input, so run the shared validator.
		if err := validateImportTracks([]queue.TrackRef{req.Track}); err != nil {
			return nil, err
		}
		// Server-owned attribution (#165): the display name is stamped from
		// the name the connection presented at connect time, never trusted
		// from the RPC payload — a crafted addedBy naming another member is
		// overridden. When the connection presented no name (or the caller
		// is transport-independent) the validated client value stands.
		// addedByUserId is likewise server-owned (RFC-0005 B16).
		if name := h.displayName(clientID); name != "" {
			req.Track.AddedBy = name
		}
		req.Track.AddedByUserID = userID
		var addedID string
		res, err := h.mutate(req.RoomID, func(s *queue.RoomState) error {
			if len(s.Queue) >= queue.MaxQueueSize {
				return userErrorf("queue is full (max %d)", queue.MaxQueueSize)
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
			return mapQueueErr(s.Remove(req.TrackID))
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
			return mapQueueErr(s.SetNowPlaying(req.TrackID))
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

		// Capture the newly playing track for the chat announcement (#205).
		var announced *queue.TrackRef

		res, err := h.mutate(req.RoomID, func(s *queue.RoomState) error {
			// Store old NowPlayingID to detect if advance actually changed state
			oldNowPlayingID := s.NowPlayingID

			if err := s.AdvanceAfter(req.AfterID); err != nil {
				return err
			}

			// Detect if advance actually changed state and queue is now empty
			if s.NowPlayingID != oldNowPlayingID && s.RadioEnabled && s.NowPlayingID == "" && len(s.Queue) > 0 {
				// Queue ran dry; capture the last track as seed for refill.
				// Copy the value: a pointer into s.Queue would race with
				// concurrent queue mutations (Move rewrites elements, Add can
				// reallocate) once refillRadio reads it after unlock.
				seed := s.Queue[len(s.Queue)-1]
				refillSeed = &seed
			}

			// A real advance to a next track (not the idempotent no-op, not
			// queue-end) announces the change in chat. Copy the value for the
			// same racing reason as refillSeed above.
			if s.NowPlayingID != oldNowPlayingID && s.NowPlayingID != "" {
				for i := range s.Queue {
					if s.Queue[i].ID == s.NowPlayingID {
						track := s.Queue[i]
						announced = &track
						break
					}
				}
			}

			return nil
		})

		// After successful mutate, trigger refill if needed (async, outside the lock)
		if err == nil && refillSeed != nil && h.similar != nil {
			go h.refillRadio(req.RoomID, refillSeed)
		}

		// The system message rides chat, not RoomState: no Version bump, no
		// store.Save beyond the advance's own write-through (#205).
		if err == nil && announced != nil {
			h.publishSystemChat(req.RoomID, fmt.Sprintf("Now playing: %s — %s", announced.Title, announced.Artist))
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
			return mapQueueErr(s.Move(req.TrackID, req.ToIndex))
		})

	case "queue.vote":
		if !h.votingEnabled {
			return nil, centrifuge.ErrorMethodNotFound
		}
		var req struct {
			RoomID  string `json:"roomId"`
			TrackID string `json:"trackId"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		if req.RoomID == "" {
			return nil, fmt.Errorf("queue.vote: roomId required")
		}
		// The voter key is the rate-limit key computed at the transport
		// boundary ("user:<userID>" or "client:<clientID>"): the server stamps
		// identity, clients never send who they are.
		res, err := h.mutate(req.RoomID, func(s *queue.RoomState) error {
			_, err := s.ToggleVote(req.TrackID, rlKey)
			if errors.Is(err, queue.ErrTrackNotFound) {
				return userErrorf("track not found")
			}
			if errors.Is(err, queue.ErrVoteCapReached) {
				return userErrorf("too many voters on that track (max %d)", queue.MaxVotersPerTrack)
			}
			return err
		})
		if err == nil && h.metrics != nil {
			h.metrics.VoteCast()
		}
		return res, err

	case "track.search":
		var req struct {
			Query  string   `json:"query"`
			Prefer []string `json:"prefer"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}

		// Validate before any upstream fanout: the query goes straight to
		// Deezer/Spotify, so reject blanks and cap length; the prefer list is
		// capped to the provider allowlist size (extras are truncated, never
		// forwarded).
		req.Query = strings.TrimSpace(req.Query)
		if req.Query == "" {
			return nil, userErrorf("search query required")
		}
		if utf8.RuneCountInString(req.Query) > maxSearchQueryLen {
			return nil, userErrorf("search query too long (max %d chars)", maxSearchQueryLen)
		}
		if len(req.Prefer) > maxSearchPrefer {
			req.Prefer = req.Prefer[:maxSearchPrefer]
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
		return h.enrichQuery("track_depth_failed", req.Title, req.Artist, h.trackDepth != nil,
			map[string]interface{}{
				"credits": []interface{}{},
				"tags":    []string{},
				"source":  "musicbrainz",
			},
			func(ctx context.Context) (interface{}, error) {
				return h.trackDepth(ctx, req.ISRC, req.Title, req.Artist)
			})

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
		return h.enrichQuery("track_lyrics_failed", req.Title, req.Artist, h.lyrics != nil,
			map[string]interface{}{"synced": []interface{}{}, "plain": "", "source": "lrclib"},
			func(ctx context.Context) (interface{}, error) {
				return h.lyrics(ctx, req.Artist, req.Title, req.Album, req.DurationMs)
			})

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
		return h.enrichQuery("listenbrainz_failed", req.Title, req.Artist, h.listenBrainz != nil,
			map[string]interface{}{
				"mbid":   "",
				"tags":   []string{},
				"source": "listenbrainz",
			},
			func(ctx context.Context) (interface{}, error) {
				return h.listenBrainz(ctx, req.ISRC, req.Title, req.Artist)
			})

	case "track.lastfm":
		var req struct {
			RoomID string `json:"roomId"`
			Artist string `json:"artist"`
			Title  string `json:"title"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		return h.enrichQuery("lastfm_enrich_failed", req.Title, req.Artist, h.lastfmEnrich != nil,
			map[string]interface{}{
				"playcount": 0,
				"listeners": 0,
				"tags":      []string{},
				"source":    "lastfm",
			},
			func(ctx context.Context) (interface{}, error) {
				return h.lastfmEnrich(ctx, req.Artist, req.Title)
			})

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
		if len(req.AddedBy) > maxImportFieldLen {
			return nil, userErrorf("addedBy too long (max %d chars)", maxImportFieldLen)
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

		// Add tracks to queue up to capacity, set AddedBy on each. Collect the
		// server-assigned IDs of exactly the tracks that were added so
		// enrichment below cannot touch pre-existing queue entries when the
		// queue was partially full (the old last-N heuristic over-enriched).
		//
		// Server-owned attribution (#165): when the connection presented a
		// display name at connect time it overrides the client-supplied
		// addedBy param, same as queue.add.
		addedBy := req.AddedBy
		if name := h.displayName(clientID); name != "" {
			addedBy = name
		}
		var addedIDs []string
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
				track.AddedBy = addedBy
				// Server-owned identity: never trust a client-supplied addedByUserId.
				track.AddedByUserID = userID
				added := s.Add(track)
				addedIDs = append(addedIDs, added.ID)
			}
			return nil
		})

		// After successful mutate, enrich exactly the tracks that were added
		if mutErr == nil && len(addedIDs) > 0 {
			room, err := h.GetOrCreateRoom(req.RoomID)
			if err != nil {
				return res, mutErr
			}
			room.mu.Lock()
			byID := make(map[string]queue.TrackRef, len(room.State.Queue))
			for _, t := range room.State.Queue {
				byID[t.ID] = t
			}
			room.mu.Unlock()

			// Launch enrichment for tracks lacking sources
			for _, id := range addedIDs {
				track, ok := byID[id]
				if !ok {
					continue
				}
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

	case "room.set_public":
		if !h.publicRoomsEnabled {
			return nil, centrifuge.ErrorMethodNotFound
		}
		var req struct {
			RoomID string  `json:"roomId"`
			Public bool    `json:"public"`
			Name   *string `json:"name"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		if req.RoomID == "" {
			return nil, fmt.Errorf("room.set_public: roomId required")
		}
		// name is optional: absent leaves the label untouched, present (after
		// trim) replaces it, and empty-after-trim clears it. Capped at
		// maxRoomNameLen chars; longer is a client bug (UserError, code 400).
		var name *string
		if req.Name != nil {
			trimmed := strings.TrimSpace(*req.Name)
			if utf8.RuneCountInString(trimmed) > maxRoomNameLen {
				return nil, userErrorf("room name too long (max %d chars)", maxRoomNameLen)
			}
			name = &trimmed
		}
		res, err := h.mutate(req.RoomID, func(s *queue.RoomState) error {
			s.Public = req.Public
			if name != nil {
				s.Name = *name
			}
			s.Version++ // directory flag changed: bump so version-guarded clients accept it
			return nil
		})
		if err == nil && h.metrics != nil {
			h.metrics.RoomSetPublic(req.Public)
		}
		return res, err

	case "room.list":
		if !h.publicRoomsEnabled {
			return nil, centrifuge.ErrorMethodNotFound
		}
		res, err := h.listPublicRooms()
		if err == nil && h.metrics != nil {
			h.metrics.RoomListed()
		}
		return res, err

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

	case "chat.send":
		if !h.chatEnabled {
			return nil, centrifuge.ErrorMethodNotFound
		}
		var req struct {
			RoomID string `json:"roomId"`
			Text   string `json:"text"`
			Name   string `json:"name"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		if req.RoomID == "" {
			return nil, fmt.Errorf("chat.send: roomId required")
		}
		return h.chatSend(req.RoomID, req.Text, req.Name, userID)

	case "chat.history":
		if !h.chatEnabled {
			return nil, centrifuge.ErrorMethodNotFound
		}
		var req struct {
			RoomID string `json:"roomId"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		if req.RoomID == "" {
			return nil, fmt.Errorf("chat.history: roomId required")
		}
		return h.chatHistoryRPC(req.RoomID)

	case "chat.delete":
		if !h.chatEnabled {
			return nil, centrifuge.ErrorMethodNotFound
		}
		var req struct {
			RoomID    string `json:"roomId"`
			MessageID string `json:"messageId"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		if req.RoomID == "" {
			return nil, fmt.Errorf("chat.delete: roomId required")
		}
		if req.MessageID == "" {
			return nil, userErrorf("message id required")
		}
		// Host gate in dispatch, not Authorize: a non-host attempt is a
		// client-visible mistake (UserError, code 400), not PermissionDenied.
		if err := h.requireHost(req.RoomID, userID, "delete messages"); err != nil {
			return nil, err
		}
		res, err := h.chatDelete(req.RoomID, req.MessageID)
		// Audited on success only, and here rather than inside chatDelete
		// because this is where the acting identity is known.
		if err == nil && h.moderationAudit != nil {
			h.moderationAudit("chat.delete", req.RoomID, userID, req.MessageID)
		}
		return res, err

	case "room.kick":
		var req struct {
			RoomID   string `json:"roomId"`
			ClientID string `json:"clientId"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		if req.RoomID == "" {
			return nil, fmt.Errorf("room.kick: roomId required")
		}
		if req.ClientID == "" {
			return nil, userErrorf("client id required")
		}
		// Host gate in dispatch, not Authorize: same UserError (400) rationale
		// as chat.delete.
		if err := h.requireHost(req.RoomID, userID, "kick members"); err != nil {
			return nil, err
		}
		res, err := h.roomKick(req.RoomID, req.ClientID)
		if err == nil && h.moderationAudit != nil {
			h.moderationAudit("room.kick", req.RoomID, userID, req.ClientID)
		}
		return res, err

	case "room.rebind":
		if h.rebindSecret == nil || h.rebindBurns == nil {
			return nil, centrifuge.ErrorMethodNotFound
		}
		var req struct {
			RoomID string `json:"roomId"`
			Proof  string `json:"proof"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		if req.RoomID == "" {
			return nil, fmt.Errorf("room.rebind: roomId required")
		}
		// The payload deliberately carries no identity field (#172, decision
		// C): the old guest identity is read from the signature-verified
		// proof token, never from client input.
		return h.roomRebind(req.RoomID, req.Proof, clientID, userID)

	case "sync.ping":
		return json.Marshal(map[string]int64{"serverNowMs": time.Now().UnixMilli()})

	default:
		return nil, centrifuge.ErrorMethodNotFound
	}
}

// enrichQuery runs one track-enrichment provider call (track.depth,
// track.lyrics, track.listenbrainz, track.lastfm) through the shared
// scaffold: an unconfigured provider or a lookup error degrades to the empty
// payload (a miss is not an RPC failure), and the lookup is bounded by a 10s
// timeout. logEvent names the structured-log event for provider errors.
func (h *Hub) enrichQuery(logEvent, title, artist string, configured bool, empty map[string]interface{}, fetch func(context.Context) (interface{}, error)) (json.RawMessage, error) {
	if !configured {
		return json.Marshal(empty)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	result, err := fetch(ctx)
	if err != nil {
		if h.logger != nil {
			h.logger.Error(logEvent, "title", title, "artist", artist, "err", err.Error())
		}
		return json.Marshal(empty)
	}

	return json.Marshal(result)
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

	// Record the display name the connection presented at connect time
	// (ConnInfo {name}) so queue attribution is stamped from the connection
	// identity (#165), never from per-RPC client input.
	if info := client.Info(); len(info) > 0 {
		var d struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(info, &d) == nil {
			h.RecordClientName(clientID, d.Name)
		}
	}

	client.OnRPC(func(e centrifuge.RPCEvent, cb centrifuge.RPCCallback) {
		// Trust boundary: reject mutations of rooms this client hasn't joined.
		// Authorize has access to client.UserID() for authenticated requests.
		if err := h.Authorize(client, e.Method, e.Data); err != nil {
			cb(centrifuge.RPCReply{}, err)
			return
		}
		reply, err := h.handleRPC(e.Method, e.Data, clientID, userID)
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
// Deliberately NOT in fanoutMethods: this Last.fm fanout is a server-side
// reaction to a queue-dry transition, not a caller-driven read. It fires at
// most once per advance that actually empties the queue (the idempotency
// guard makes repeats no-ops), and the trigger RPC (now_playing.advance) is
// host-only and membership-gated, so a caller cannot multiply upstream calls
// beyond one per real dry-queue transition. Per-caller limiting would key on
// the advancing host while the cost is room-scoped.
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
