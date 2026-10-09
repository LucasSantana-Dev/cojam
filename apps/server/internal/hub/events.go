package hub

import (
	"sync"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/events"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// Product events (owner decision 2026-10-09). The hub only names what
// happened; internal/events hashes the room and actor ids, allowlists the
// props and buffers the write. Nothing here may put a nickname, chat text,
// search text or IP into an Event: the Props allowlist drops them anyway, but
// the first line of defence is not passing them.
//
// Where each event is emitted:
//
//	room_created   getOrLoadRoom, when the room did not exist in memory or the store
//	room_joined    Join, on a new membership (not on a resubscribe of the same pair)
//	track_started  mutateRoom, whenever a mutation changes NowPlayingID to a track
//	track_skipped  advanceAfterWith (see emitTrackSkipped)
//	track_liked    reactionWoot
//	search         dispatch "track.search"; main.go for matcher lookups
//	provider_connected  cmd/server spotifyExchangeHandler
//	listener_peak  peakTracker, flushed by StartPeakFlusher

// WithEvents wires the product event sink. A nil sink turns events off.
func (h *Hub) WithEvents(s events.Sink) *Hub {
	h.events = s
	return h
}

// emit hands one event to the sink. Nil-safe; the sink must not block.
func (h *Hub) emit(e events.Event) {
	if h.events != nil {
		h.events.Emit(e)
	}
}

// actorKey is the pseudonymisation input for a connection: "user:<id>" for an
// authenticated or anonymous-room-auth identity (stable per account or
// browser), else "client:<connection id>" (stable only for one connection).
func (h *Hub) actorKey(clientID string) string {
	if clientID == "" {
		return ""
	}
	return rateLimitKey(clientID, h.userIDOf(clientID))
}

// Skip reasons for track_skipped.by. "vote" is reserved for the vote-skip
// path (PR #440, now_playing.vote_skip): once its skip lands, adding the
// event is the single call
//
//	h.emitTrackSkipped(roomID, voterKey, "vote")
//
// next to the skip_by_vote branch, nothing else changes.
const (
	skipByHost = "host"
	skipByAuto = "auto"
	skipByVote = "vote"
)

// emitTrackSkipped records that the playing track was skipped. by is one of
// skipByHost, skipByAuto, skipByVote; actor is the caller's rate-limit key or
// "" when nobody caused it (auto).
func (h *Hub) emitTrackSkipped(roomID, actor, by string) {
	h.emit(events.Event{Name: events.TrackSkipped, RoomID: roomID, ActorID: actor, Props: map[string]any{"by": by}})
}

// earlySkipGraceMs is how far before the catalogue end an advance still counts
// as the track finishing rather than a skip. The catalogue duration is not
// always the played video's (see queue.EndedGraceMs), so this is an
// approximation: a host advancing within the last 15 s is not a skip.
const earlySkipGraceMs = 15_000

// advancedEarly reports whether an advance past the playing track happens
// before it could have ended. It needs a transport and a known duration; with
// either missing it answers false, so no skip is recorded rather than a guess.
// Callers hold the room lock.
func advancedEarly(s *queue.RoomState, nowMs int64) bool {
	t := s.Transport
	if t == nil || s.NowPlayingID == "" {
		return false
	}
	tr := s.Track(s.NowPlayingID)
	if tr == nil || tr.DurationMs <= 0 {
		return false
	}
	pos := t.PositionMs
	if t.State == "playing" {
		pos += nowMs - t.UpdatedAtServerMs
	}
	return pos+earlySkipGraceMs < tr.DurationMs
}

// trackStartedEvent builds the track_started event when a mutation moved
// playback to a new track. prevPlaying is NowPlayingID before the mutation.
// Callers hold the room lock; the event is emitted after it is released.
//
// provider is the only source the track carries (the service a client plays it
// on is chosen per listener, "Ouvir no", and unknown here), "other" when it
// has both or neither. source is the track's origin (radio, history); a track
// that started on an idle room is "manual" (someone picked it), one that
// followed another is "autoplay" (it came up from the queue).
func trackStartedEvent(roomID, prevPlaying string, s *queue.RoomState) (events.Event, bool) {
	if s.NowPlayingID == "" || s.NowPlayingID == prevPlaying {
		return events.Event{}, false
	}
	tr := s.Track(s.NowPlayingID)
	if tr == nil {
		return events.Event{}, false
	}
	provider := "other"
	switch yt, sp := tr.Sources.YouTube != nil, tr.Sources.Spotify != nil; {
	case yt && !sp:
		provider = "youtube"
	case sp && !yt:
		provider = "spotify"
	}
	source := "autoplay"
	switch {
	case tr.Origin == queue.OriginRadio:
		source = "radio"
	case tr.Origin == queue.OriginHistory:
		source = "history"
	case prevPlaying == "":
		source = "manual"
	}
	return events.Event{Name: events.TrackStarted, RoomID: roomID, Props: map[string]any{"provider": provider, "source": source}}, true
}

// peakTracker keeps, per room, the highest member count seen in the current
// UTC hour. It is memory only and bounded by the rooms active this hour.
// listener_peak is emitted once per room per hour: when the first join of a
// later hour arrives, or when the flusher finds the hour over.
type peakTracker struct {
	mu sync.Mutex
	m  map[string]peakEntry
}

type peakEntry struct {
	hour time.Time
	n    int
}

// maxPeakRooms bounds the map; rooms past it are not tracked this hour.
const maxPeakRooms = 50000

type finishedPeak struct {
	roomID string
	peakEntry
}

// observe records a member count for roomID at now and returns the previous
// hour's entry when the hour rolled over for this room.
func (p *peakTracker) observe(roomID string, n int, now time.Time) (finishedPeak, bool) {
	hour := now.UTC().Truncate(time.Hour)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.m == nil {
		p.m = make(map[string]peakEntry)
	}
	cur, ok := p.m[roomID]
	switch {
	case !ok:
		if len(p.m) >= maxPeakRooms {
			return finishedPeak{}, false
		}
		p.m[roomID] = peakEntry{hour: hour, n: n}
		return finishedPeak{}, false
	case cur.hour.Equal(hour):
		if n > cur.n {
			cur.n = n
			p.m[roomID] = cur
		}
		return finishedPeak{}, false
	default:
		p.m[roomID] = peakEntry{hour: hour, n: n}
		return finishedPeak{roomID: roomID, peakEntry: cur}, true
	}
}

// drain removes and returns the entries whose hour ended before now (all of
// them when all is true, used at shutdown).
func (p *peakTracker) drain(now time.Time, all bool) []finishedPeak {
	hour := now.UTC().Truncate(time.Hour)
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []finishedPeak
	for id, e := range p.m {
		if all || e.hour.Before(hour) {
			out = append(out, finishedPeak{roomID: id, peakEntry: e})
			delete(p.m, id)
		}
	}
	return out
}

func (h *Hub) emitPeak(f finishedPeak) {
	// At is the start of the hour the count describes, so a dashboard buckets
	// it where it belongs and not where the flusher happened to run.
	h.emit(events.Event{At: f.hour, Name: events.ListenerPeak, RoomID: f.roomID, Props: map[string]any{"n": f.n}})
}

// observePeak feeds the tracker from Join.
func (h *Hub) observePeak(roomID string, members int) {
	if h.events == nil {
		return
	}
	if f, done := h.peaks.observe(roomID, members, time.Now()); done {
		h.emitPeak(f)
	}
}

// peakFlushEvery is how often StartPeakFlusher looks for finished hours.
const peakFlushEvery = 5 * time.Minute

// StartPeakFlusher emits listener_peak for rooms whose hour ended without a
// later join, every few minutes. The returned stop emits everything still held
// (the current hour's partial peak is better kept than lost on a deploy) and
// returns after the loop exits.
func (h *Hub) StartPeakFlusher() (stop func()) {
	if h.events == nil {
		return func() {}
	}
	quit := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() { _ = recover() }()
		t := time.NewTicker(peakFlushEvery)
		defer t.Stop()
		for {
			select {
			case <-quit:
				return
			case now := <-t.C:
				h.flushPeaks(now, false)
			}
		}
	}()
	return func() {
		close(quit)
		<-done
		h.flushPeaks(time.Now(), true)
	}
}

func (h *Hub) flushPeaks(now time.Time, all bool) {
	for _, f := range h.peaks.drain(now, all) {
		h.emitPeak(f)
	}
}
