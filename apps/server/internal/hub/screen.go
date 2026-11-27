package hub

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// Screen share v1 (#310, docs/specs/310-screen-share.md, ADR-0008).
//
// One member of a private room shares their screen with at most
// screenMaxViewers other members over a WebRTC P2P mesh. The server owns
// who may share and who may watch, and relays SDP and ICE candidates
// (signal.go). It never carries media bytes.
//
// Session state lives on Room (guarded by room.mu) and is projected onto
// every outbound RoomState as RoomState.Screen. It is never persisted: it
// describes live connections that die with the process.

// screenMaxViewers is the v1 viewer cap (C3): a broadcaster uploads one
// stream per viewer, so the cap is a bandwidth bound, not a policy knob.
const screenMaxViewers = 5

// screenRoomIDRe is the current room id generator format
// (apps/web/lib/roomId.ts). A private room's privacy rests on its id being
// unguessable, so the shorter legacy ids cannot host a share (C6).
var screenRoomIDRe = regexp.MustCompile(`^[0-9A-Z]{12}$`)

// ValidScreenRoomID reports whether a room id can host a screen share (the
// current 12-char format). The flag panel validates its allowlist with it.
func ValidScreenRoomID(id string) bool { return screenRoomIDRe.MatchString(id) }

// Session end reasons: the fixed label set of
// music_jam_screen_sessions_ended_total{reason}.
const (
	screenEndStopped     = "stopped"
	screenEndHostStopped = "host_stopped"
	screenEndDisconnect  = "disconnect"
	screenEndKicked      = "kicked"
	screenEndTakeover    = "takeover"
	screenEndShutdown    = "shutdown"
	screenEndClosed      = "closed"
	// screenEndDisabled: the operator turned screen share off, or took the
	// room off the allowlist, while the server runs (SetFeatures).
	screenEndDisabled = "disabled"
)

// screen.watch rejection reasons: the label set of
// music_jam_screen_watch_rejected_total{reason}.
const (
	screenRejectFull    = "full"
	screenRejectNoShare = "no_share"
	screenRejectSelf    = "self"
	screenRejectLocked  = "locked"
	screenRejectRefused = "refused"
)

// screenMethods are the screen share RPCs. All are membership-gated
// (mutatingMethods) and return ErrorMethodNotFound while the feature is off.
var screenMethods = map[string]bool{
	"screen.start":   true,
	"screen.stop":    true,
	"screen.watch":   true,
	"screen.unwatch": true,
	"screen.lock":    true,
	"screen.refuse":  true,
	"rtc.signal":     true,
}

// screenSession is one live share. Guarded by the owning Room's mu.
type screenSession struct {
	broadcasterClientID string
	broadcasterUserID   string
	broadcasterName     string
	ageAffirmed         bool
	startedAt           time.Time
	// viewers maps a viewer key (userID, see viewerKey) to the connection
	// holding that person's one slot.
	viewers map[string]string
	// refused holds viewer keys the host or broadcaster removed for the rest
	// of this session (screen.refuse).
	refused     map[string]struct{}
	locked      bool
	peakViewers int
}

func (s *screenSession) projection() *queue.ScreenShareState {
	return &queue.ScreenShareState{
		BroadcasterID:   s.broadcasterClientID,
		BroadcasterName: s.broadcasterName,
		StartedAtMs:     s.startedAt.UnixMilli(),
		ViewerCount:     len(s.viewers),
		MaxViewers:      screenMaxViewers,
		Locked:          s.locked,
	}
}

// isViewer reports whether clientID holds an admitted slot.
func (s *screenSession) isViewer(clientID string) bool {
	for _, c := range s.viewers {
		if c == clientID {
			return true
		}
	}
	return false
}

// removeViewerClient drops the slot held by clientID and reports whether one
// was held.
func (s *screenSession) removeViewerClient(clientID string) bool {
	for k, c := range s.viewers {
		if c == clientID {
			delete(s.viewers, k)
			return true
		}
	}
	return false
}

// screenEnded is what is left of a session after it ends: enough for the
// trail, the metrics, the chat line and the index cleanup, all of which run
// after room.mu is released.
type screenEnded struct {
	roomID  string
	session screenSession
	reason  string
	actor   string // userID of whoever ended it ("" for disconnects)
	endedAt time.Time
}

// screenState is the hub-level screen share state.
type screenState struct {
	// enabled and allowlist change at runtime (SetFeatures). allowlist
	// points at a map never written after it is stored; nil (or a nil
	// pointer) = every eligible private room.
	enabled   atomic.Bool
	allowlist atomic.Pointer[map[string]struct{}]

	// mu guards byClient, the cleanup index: clientID -> rooms where that
	// connection broadcasts or watches. Only screen RPCs write it and only
	// screen cleanup clears it. It is deliberately not the membership index:
	// room.kick drops membership before the disconnect runs (spec section 3).
	// Never held across mutate.
	mu       sync.Mutex
	byClient map[string]map[string]struct{}
}

// ScreenAudit records a screen share event in the durable moderation trail
// (#259, spec 4.4): action is screen.start, screen.stop, screen.host_stop or
// screen.refuse. detail carries no content and no network addresses. Nil
// disables it.
type ScreenAudit func(action, roomID, actorUserID, subjectID string, detail map[string]any)

// WithScreenShare enables the screen share RPCs (FEATURE_SCREENSHARE, #310).
// allowlist, when non-empty, limits shares to those room ids
// (SCREENSHARE_ROOM_ALLOWLIST, the named-test-rooms rollout stage).
func (h *Hub) WithScreenShare(enabled bool, allowlist []string) *Hub {
	h.screen.enabled.Store(enabled)
	h.screen.allowlist.Store(screenAllowSet(allowlist))
	return h
}

// screenAllowSet builds the allowlist set, nil when no id is given.
func screenAllowSet(allowlist []string) *map[string]struct{} {
	var set map[string]struct{}
	for _, id := range allowlist {
		if id = strings.TrimSpace(id); id != "" {
			if set == nil {
				set = make(map[string]struct{})
			}
			set[id] = struct{}{}
		}
	}
	if set == nil {
		return nil
	}
	return &set
}

// screenAllowed reports whether roomID may host a share under the current
// allowlist.
func (h *Hub) screenAllowed(roomID string) bool {
	set := h.screen.allowlist.Load()
	if set == nil {
		return true
	}
	_, ok := (*set)[roomID]
	return ok
}

// WithScreenAudit wires the durable trail for screen share sessions.
func (h *Hub) WithScreenAudit(fn ScreenAudit) *Hub {
	h.screenAudit = fn
	return h
}

// viewerKey is the identity a viewer slot and a refusal are keyed by: one
// person in two tabs holds one slot. Screen share requires room auth, so the
// userID is always set in practice; the client id fallback only keeps an
// unauthenticated test path from collapsing every viewer into one key.
func viewerKey(clientID, userID string) string {
	if userID != "" {
		return "user:" + userID
	}
	return "client:" + clientID
}

// indexAdd records that clientID takes part in roomID's share.
func (h *Hub) screenIndexAdd(clientID, roomID string) {
	h.screen.mu.Lock()
	defer h.screen.mu.Unlock()
	if h.screen.byClient == nil {
		h.screen.byClient = make(map[string]map[string]struct{})
	}
	if h.screen.byClient[clientID] == nil {
		h.screen.byClient[clientID] = make(map[string]struct{})
	}
	h.screen.byClient[clientID][roomID] = struct{}{}
}

// screenIndexRemove drops clientID's entry for roomID.
func (h *Hub) screenIndexRemove(clientID, roomID string) {
	h.screen.mu.Lock()
	defer h.screen.mu.Unlock()
	delete(h.screen.byClient[clientID], roomID)
	if len(h.screen.byClient[clientID]) == 0 {
		delete(h.screen.byClient, clientID)
	}
}

// screenRoomsOf returns the rooms where clientID broadcasts or watches.
func (h *Hub) screenRoomsOf(clientID string) []string {
	h.screen.mu.Lock()
	defer h.screen.mu.Unlock()
	rooms := make([]string, 0, len(h.screen.byClient[clientID]))
	for roomID := range h.screen.byClient[clientID] {
		rooms = append(rooms, roomID)
	}
	return rooms
}

// residentRoom returns the in-memory room, never loading or creating one:
// cleanup must not resurrect a room that was closed or evicted.
func (h *Hub) residentRoom(roomID string) *Room {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.rooms[roomID]
}

// endSessionLocked detaches roomID's live share and drops every index entry
// it owns. Callers hold room.mu (screen.mu is a leaf lock), so index and
// session state change together: a disconnect can never read an index that
// lags the session, and a late cleanup can never erase a newer session's
// entries.
func (h *Hub) endSessionLocked(room *Room, roomID, reason, actor string) *screenEnded {
	cur := room.screen
	if cur == nil {
		return nil
	}
	room.screen = nil
	h.screenIndexRemove(cur.broadcasterClientID, roomID)
	for _, c := range cur.viewers {
		h.screenIndexRemove(c, roomID)
	}
	return &screenEnded{roomID: roomID, session: *cur, reason: reason, actor: actor, endedAt: time.Now()}
}

// mutateScreen runs fn under room.mu with the Room at hand, through the
// normal mutate path (version bump, save, publish). Screen RPCs touch no
// queue, so the sourceless auto-skip and the video heartbeat do not apply.
func (h *Hub) mutateScreen(roomID string, fn func(room *Room, s *queue.RoomState) error) (json.RawMessage, error) {
	room, err := h.GetOrCreateRoom(roomID)
	if err != nil {
		return nil, err
	}
	return h.mutateRoom(roomID, room, func(s *queue.RoomState) error { return fn(room, s) })
}

// screenStart handles screen.start (spec 2.2). Host checks run inside the
// mutate closure and fail closed: an empty HostUserID is a refusal.
func (h *Hub) screenStart(roomID, clientID, userID string, ageAffirmed bool) (json.RawMessage, error) {
	if !ageAffirmed {
		return nil, userErrorf("Confirme sua idade para compartilhar a tela.")
	}
	if !screenRoomIDRe.MatchString(roomID) {
		return nil, userErrorf("O compartilhamento de tela precisa de um link de sala mais novo. Crie uma sala nova.")
	}
	if !h.screenAllowed(roomID) {
		return nil, userErrorf("O compartilhamento de tela ainda não está disponível nesta sala.")
	}
	name := h.displayName(clientID)
	if name == "" {
		name = "Alguém"
	}
	var ended *screenEnded
	started := false
	res, err := h.mutateScreen(roomID, func(room *Room, s *queue.RoomState) error {
		// Checked again under room.mu: SetFeatures may have turned screen
		// share off (or dropped this room) since the checks above, and its
		// sweep would not see a share created after it ran.
		if !h.screen.enabled.Load() {
			return centrifuge.ErrorMethodNotFound
		}
		if !h.screenAllowed(roomID) {
			return userErrorf("O compartilhamento de tela ainda não está disponível nesta sala.")
		}
		cur := room.screen
		if cur != nil && cur.broadcasterClientID == clientID {
			return nil // already sharing from this connection: idempotent
		}
		takeover := cur != nil && userID != "" && cur.broadcasterUserID == userID
		// Takeover is still host-only: a broadcaster who lost the host role
		// keeps the running share but cannot open a new one.
		if !s.IsHostOrOwner(userID) {
			return userErrorf("Só o host pode compartilhar a tela.")
		}
		if s.Public {
			return userErrorf("O compartilhamento de tela só funciona em salas privadas.")
		}
		if cur != nil && !takeover {
			return userErrorf("%s já está compartilhando a tela.", cur.broadcasterName)
		}
		now := time.Now()
		if takeover {
			// Same person, new connection (a reload, or a dropped connection
			// whose disconnect has not been detected yet): end the old
			// session so its owner is not locked out for the ping timeout.
			ended = h.endSessionLocked(room, roomID, screenEndTakeover, userID)
		}
		room.screen = &screenSession{
			broadcasterClientID: clientID,
			broadcasterUserID:   userID,
			broadcasterName:     name,
			ageAffirmed:         ageAffirmed,
			startedAt:           now,
			viewers:             make(map[string]string),
			refused:             make(map[string]struct{}),
		}
		h.screenIndexAdd(clientID, roomID)
		started = true
		s.Version++
		return nil
	})
	if err != nil {
		return nil, err
	}
	if ended != nil {
		h.finishScreenSession(*ended, false)
	}
	if started {
		if h.metrics != nil {
			h.metrics.ScreenSessionStarted()
		}
		if h.screenAudit != nil {
			h.screenAudit("screen.start", roomID, userID, userID, map[string]any{
				"name":        name,
				"startedAt":   time.Now().UnixMilli(),
				"ageAffirmed": ageAffirmed,
			})
		}
		h.publishSystemChat(roomID, fmt.Sprintf("%s começou a compartilhar a tela", name))
		if h.logger != nil {
			h.logger.Info("screen_started", "room_id", roomID, "client_id", clientID)
		}
	}
	return res, nil
}

// screenStop handles screen.stop: the broadcaster ends their own share, the
// host (or owner) ends anyone's. Stopping when nothing is live is a no-op, so
// a client racing the browser's own "stop sharing" never sees an error.
func (h *Hub) screenStop(roomID, clientID, userID string) (json.RawMessage, error) {
	var ended *screenEnded
	res, err := h.mutateScreen(roomID, func(room *Room, s *queue.RoomState) error {
		cur := room.screen
		if cur == nil {
			return nil
		}
		reason := screenEndStopped
		own := cur.broadcasterClientID == clientID || (userID != "" && cur.broadcasterUserID == userID)
		if !own {
			if !s.IsHostOrOwner(userID) {
				return userErrorf("Só quem compartilha ou o host pode encerrar o compartilhamento.")
			}
			reason = screenEndHostStopped
		}
		ended = h.endSessionLocked(room, roomID, reason, userID)
		s.Version++
		return nil
	})
	if err != nil {
		return nil, err
	}
	if ended != nil {
		h.finishScreenSession(*ended, true)
	}
	return res, nil
}

// screenWatch admits the caller as a viewer (C3) and tells the broadcaster to
// open a peer connection. Nothing is automatic: a viewer only ever receives a
// stream after this explicit call.
func (h *Hub) screenWatch(roomID, clientID, userID string) (json.RawMessage, error) {
	key := viewerKey(clientID, userID)
	var broadcaster, movedFrom string
	var rejected string
	res, err := h.mutateScreen(roomID, func(room *Room, s *queue.RoomState) error {
		cur := room.screen
		switch {
		case cur == nil:
			rejected = screenRejectNoShare
			return userErrorf("Ninguém está compartilhando a tela agora.")
		case cur.broadcasterClientID == clientID:
			rejected = screenRejectSelf
			return userErrorf("Você é quem está compartilhando.")
		}
		broadcaster = cur.broadcasterClientID
		if held, ok := cur.viewers[key]; ok {
			if held == clientID {
				return nil // already admitted: re-notify the broadcaster below
			}
			// One slot per person: the slot moves to the new connection.
			movedFrom = held
			cur.viewers[key] = clientID
			h.screenIndexRemove(held, roomID)
			h.screenIndexAdd(clientID, roomID)
			s.Version++
			return nil
		}
		if _, ok := cur.refused[key]; ok {
			rejected = screenRejectRefused
			return userErrorf("Quem compartilha não está aceitando novos espectadores.")
		}
		if cur.locked {
			rejected = screenRejectLocked
			return userErrorf("Quem compartilha não está aceitando novos espectadores.")
		}
		if len(cur.viewers) >= screenMaxViewers {
			rejected = screenRejectFull
			return userErrorf("O compartilhamento está cheio (%d espectadores).", screenMaxViewers)
		}
		cur.viewers[key] = clientID
		h.screenIndexAdd(clientID, roomID)
		if len(cur.viewers) > cur.peakViewers {
			cur.peakViewers = len(cur.viewers)
		}
		s.Version++
		return nil
	})
	if err != nil {
		if rejected != "" && h.metrics != nil {
			h.metrics.ScreenWatchRejected(rejected)
		}
		return nil, err
	}
	_ = res
	if movedFrom != "" {
		h.notifyScreenViewer(broadcaster, roomID, movedFrom, "leave")
		h.notifyScreenViewer(movedFrom, roomID, movedFrom, "leave")
	}
	h.notifyScreenViewer(broadcaster, roomID, clientID, "join")
	return json.Marshal(map[string]string{"broadcasterId": broadcaster})
}

// screenUnwatch ends the caller's viewing. Always allowed, and a no-op when
// the caller was not watching: anyone can stop watching at any moment.
func (h *Hub) screenUnwatch(roomID, clientID string) (json.RawMessage, error) {
	if err := h.screenViewerLeave(roomID, clientID); err != nil {
		return nil, err
	}
	return json.Marshal(map[string]string{})
}

// screenViewerLeave frees clientID's viewer slot in roomID, publishes and
// tells the broadcaster to close that peer. No-op when clientID holds none.
// During shutdown the slot is freed in place, with no publication.
func (h *Hub) screenViewerLeave(roomID, clientID string) error {
	room := h.residentRoom(roomID)
	if room == nil {
		h.screenIndexRemove(clientID, roomID)
		return nil
	}
	var broadcaster string
	leave := func(s *queue.RoomState) bool {
		cur := room.screen
		if cur == nil || !cur.removeViewerClient(clientID) {
			return false
		}
		h.screenIndexRemove(clientID, roomID)
		broadcaster = cur.broadcasterClientID
		return true
	}
	if h.roles.shuttingDown.Load() {
		room.mu.Lock()
		leave(room.State)
		room.mu.Unlock()
		return nil
	}
	_, err := h.mutateRoom(roomID, room, func(s *queue.RoomState) error {
		if leave(s) {
			s.Version++
		}
		return nil
	})
	if err != nil {
		return err
	}
	if broadcaster != "" {
		h.notifyScreenViewer(broadcaster, roomID, clientID, "leave")
	}
	return nil
}

// screenLock opens or closes admission (C12). Admitted viewers stay.
func (h *Hub) screenLock(roomID, clientID, userID string, locked bool) (json.RawMessage, error) {
	return h.mutateScreen(roomID, func(room *Room, s *queue.RoomState) error {
		cur := room.screen
		if cur == nil {
			return userErrorf("Ninguém está compartilhando a tela agora.")
		}
		if cur.broadcasterClientID != clientID && !s.IsHostOrOwner(userID) {
			return userErrorf("Só quem compartilha ou o host pode fechar a entrada.")
		}
		if cur.locked == locked {
			return nil
		}
		cur.locked = locked
		s.Version++
		return nil
	})
}

// screenRefuse removes a person from this share for the rest of the session
// (C12): every connection of theirs loses its slot and their key cannot
// watch again until the share ends. Kick is not a ban, and neither is this:
// a fresh identity can come back, which is why screen.lock exists.
func (h *Hub) screenRefuse(roomID, clientID, userID, targetClientID string) (json.RawMessage, error) {
	if targetClientID == "" {
		return nil, userErrorf("client id required")
	}
	// Resolved before taking the room lock (clientUserIDMu is never taken
	// under room.mu); the session's own slot map wins when the target holds a
	// slot, so a connection that just dropped is still refused by person.
	targetUser := h.userIDOf(targetClientID)
	var targetKey string
	var broadcaster string
	var removed []string
	refusedOK := false
	_, err := h.mutateScreen(roomID, func(room *Room, s *queue.RoomState) error {
		cur := room.screen
		if cur == nil {
			return userErrorf("Ninguém está compartilhando a tela agora.")
		}
		if cur.broadcasterClientID != clientID && !s.IsHostOrOwner(userID) {
			return userErrorf("Só quem compartilha ou o host pode remover alguém.")
		}
		if targetClientID == cur.broadcasterClientID {
			return userErrorf("Para encerrar o compartilhamento, use parar.")
		}
		for k, c := range cur.viewers {
			if c == targetClientID {
				targetKey = k
			}
		}
		if targetKey == "" {
			if targetUser == "" || !h.IsMember(targetClientID, roomID) {
				return userErrorf("that member is not in this room")
			}
			targetKey = viewerKey(targetClientID, targetUser)
		}
		broadcaster = cur.broadcasterClientID
		cur.refused[targetKey] = struct{}{}
		if held, ok := cur.viewers[targetKey]; ok {
			removed = append(removed, held)
			delete(cur.viewers, targetKey)
			h.screenIndexRemove(held, roomID)
		}
		refusedOK = true
		s.Version++
		return nil
	})
	if err != nil {
		return nil, err
	}
	if refusedOK && h.screenAudit != nil {
		h.screenAudit("screen.refuse", roomID, userID, strings.TrimPrefix(targetKey, "user:"), map[string]any{})
	}
	for _, c := range removed {
		h.notifyScreenViewer(broadcaster, roomID, c, "leave")
		h.notifyScreenViewer(c, roomID, c, "leave")
	}
	return json.Marshal(map[string]string{})
}

// screenLeave is the cleanup for a connection leaving a room's share: a
// broadcaster's departure ends the session, a viewer's frees the slot.
// Idempotent, and safe for a room that is no longer resident. room.kick runs
// it before dropping membership; ScreenOnDisconnect runs it on disconnect.
func (h *Hub) screenLeave(roomID, clientID, reason string) {
	room := h.residentRoom(roomID)
	if room == nil {
		h.screenIndexRemove(clientID, roomID)
		return
	}
	room.mu.Lock()
	cur := room.screen
	isBroadcaster := cur != nil && cur.broadcasterClientID == clientID
	isViewer := cur != nil && !isBroadcaster && cur.isViewer(clientID)
	room.mu.Unlock()

	switch {
	case isBroadcaster:
		var ended *screenEnded
		if h.roles.shuttingDown.Load() {
			// The server is going away: end in place, no publication into a
			// node that is shutting down.
			room.mu.Lock()
			if room.screen != nil && room.screen.broadcasterClientID == clientID {
				ended = h.endSessionLocked(room, roomID, screenEndShutdown, "")
			}
			room.mu.Unlock()
			if ended != nil {
				h.finishScreenSession(*ended, false)
			}
			return
		}
		_, err := h.mutateRoom(roomID, room, func(s *queue.RoomState) error {
			if room.screen == nil || room.screen.broadcasterClientID != clientID {
				return nil
			}
			ended = h.endSessionLocked(room, roomID, reason, "")
			s.Version++
			return nil
		})
		if err != nil && h.logger != nil {
			h.logger.Error("screen_leave_failed", "room_id", roomID, "err", err.Error())
		}
		if ended != nil {
			h.finishScreenSession(*ended, true)
		}
	case isViewer:
		if err := h.screenViewerLeave(roomID, clientID); err != nil && h.logger != nil {
			h.logger.Error("screen_leave_failed", "room_id", roomID, "err", err.Error())
		}
	default:
		// Not (or no longer) part of this share: drop a stale entry, under the
		// room lock so it cannot race a concurrent watch or start.
		room.mu.Lock()
		if room.screen == nil || (room.screen.broadcasterClientID != clientID && !room.screen.isViewer(clientID)) {
			h.screenIndexRemove(clientID, roomID)
		}
		room.mu.Unlock()
	}
}

// ScreenOnDisconnect ends or leaves every share the connection took part in.
// It resolves rooms from the screen index, not from membership, so it still
// works after room.kick or room.rebind already dropped the membership. Must
// run first in OnDisconnect.
func (h *Hub) ScreenOnDisconnect(clientID string) {
	for _, roomID := range h.screenRoomsOf(clientID) {
		h.screenLeave(roomID, clientID, screenEndDisconnect)
	}
}

// screenCloseRoom ends a room's share in place when the operator closes the
// room (closed.go): the room is about to leave memory, so nothing is
// published, but the end still reaches the trail and the metrics.
func (h *Hub) screenCloseRoom(roomID string) {
	room := h.residentRoom(roomID)
	if room == nil {
		return
	}
	room.mu.Lock()
	var ended *screenEnded
	ended = h.endSessionLocked(room, roomID, screenEndClosed, "")
	room.mu.Unlock()
	if ended != nil {
		h.finishScreenSession(*ended, false)
	}
}

// screenLive reports whether a share is live in roomID. Read-only.
func (h *Hub) screenLive(roomID string) bool {
	room := h.residentRoom(roomID)
	if room == nil {
		return false
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	return room.screen != nil
}

// finishScreenSession runs everything that follows the end of a session once
// room.mu is released: index cleanup, viewer notices, metrics, trail and the
// chat line (announce false skips the line, for ends nobody is left to read).
func (h *Hub) finishScreenSession(e screenEnded, announce bool) {
	sess := e.session
	// Tell every connection of the ended session, so a well-behaved client
	// closes its peers even before (or without) the state publication: after
	// a takeover the old tab otherwise keeps peers outside any server state.
	h.notifyScreenEnded(sess.broadcasterClientID, e.roomID)
	for _, c := range sess.viewers {
		h.notifyScreenEnded(c, e.roomID)
	}
	if h.metrics != nil {
		h.metrics.ScreenSessionEnded(e.reason, sess.peakViewers)
	}
	if h.screenAudit != nil {
		action := "screen.stop"
		actor := sess.broadcasterUserID
		if e.reason == screenEndHostStopped {
			action = "screen.host_stop"
			actor = e.actor
		}
		h.screenAudit(action, e.roomID, actor, sess.broadcasterUserID, map[string]any{
			"name":        sess.broadcasterName,
			"startedAt":   sess.startedAt.UnixMilli(),
			"endedAt":     e.endedAt.UnixMilli(),
			"peakViewers": sess.peakViewers,
			"ageAffirmed": sess.ageAffirmed,
			"reason":      e.reason,
		})
	}
	if announce {
		line := fmt.Sprintf("%s parou de compartilhar a tela", sess.broadcasterName)
		switch e.reason {
		case screenEndHostStopped:
			line = "O host encerrou o compartilhamento de tela"
		case screenEndDisabled:
			line = "O compartilhamento de tela foi desligado nesta sala"
		}
		h.publishSystemChat(e.roomID, line)
	}
	if h.logger != nil {
		h.logger.Info("screen_ended", "room_id", e.roomID, "reason", e.reason, "peak_viewers", sess.peakViewers,
			"duration_s", int(e.endedAt.Sub(sess.startedAt).Seconds()))
	}
}

// requireScreen gates every screen RPC on the feature flag.
func (h *Hub) requireScreen() error {
	if !h.screen.enabled.Load() {
		return centrifuge.ErrorMethodNotFound
	}
	return nil
}

// dispatchScreen decodes and routes the screen share RPCs.
func (h *Hub) dispatchScreen(method string, data []byte, clientID, userID string) (json.RawMessage, error) {
	if err := h.requireScreen(); err != nil {
		return nil, err
	}
	if method == "rtc.signal" {
		return h.rtcSignal(data, clientID, userID)
	}
	var req struct {
		RoomID      string `json:"roomId"`
		AgeAffirmed bool   `json:"ageAffirmed"`
		Locked      bool   `json:"locked"`
		ClientID    string `json:"clientId"`
	}
	if err := json.Unmarshal(data, &req); err != nil {
		return nil, err
	}
	if req.RoomID == "" {
		return nil, fmt.Errorf("%s: roomId required", method)
	}
	switch method {
	case "screen.start":
		return h.screenStart(req.RoomID, clientID, userID, req.AgeAffirmed)
	case "screen.stop":
		return h.screenStop(req.RoomID, clientID, userID)
	case "screen.watch":
		return h.screenWatch(req.RoomID, clientID, userID)
	case "screen.unwatch":
		return h.screenUnwatch(req.RoomID, clientID)
	case "screen.lock":
		return h.screenLock(req.RoomID, clientID, userID, req.Locked)
	case "screen.refuse":
		return h.screenRefuse(req.RoomID, clientID, userID, req.ClientID)
	}
	return nil, centrifuge.ErrorMethodNotFound
}

// ScreenSummary renders a session's trail detail as the stored content of a
// broadcast report: compact JSON with sorted keys, no content and no network
// addresses (#310, spec 7.3).
func ScreenSummary(detail map[string]any) string {
	b, err := json.Marshal(detail)
	if err != nil {
		return ""
	}
	return string(b)
}

// notifyScreenEnded tells one connection that the share it took part in
// ended. Best effort, like notifyScreenViewer.
func (h *Hub) notifyScreenEnded(target, roomID string) {
	msg, err := json.Marshal(map[string]string{"type": "screen.ended", "roomId": roomID})
	if err != nil {
		return
	}
	_ = h.sendToClient(target, msg)
}
