// Package events records first-party product events (owner decision
// 2026-10-09) into CoJam's own Postgres, the way Lucky records command_events.
//
// Privacy contract, enforced here and not left to callers:
//   - Room and actor ids are pseudonymised with a keyed HMAC (Hasher) before
//     they reach the buffer; the clear value never leaves Emit.
//   - Only the event names and prop keys below exist. A prop with an unknown
//     key, or a string value outside its enum, is dropped, so a caller cannot
//     smuggle a nickname, chat line or search text into the table by mistake.
//   - Nothing is ever recorded about IPs.
package events

import "time"

// Event names. Exact strings: dashboards and the privacy page refer to them.
const (
	RoomCreated       = "room_created"
	RoomJoined        = "room_joined"
	TrackStarted      = "track_started"
	TrackSkipped      = "track_skipped"
	TrackLiked        = "track_liked"
	Search            = "search"
	ProviderConnected = "provider_connected"
	ListenerPeak      = "listener_peak"
)

// Event is what a call site hands to a Sink. RoomID and ActorID are clear
// values for the in-process hand-off only; the Writer hashes them. Either may
// be empty (stored as NULL).
type Event struct {
	// At is the event time; zero means now.
	At      time.Time
	Name    string
	RoomID  string
	ActorID string
	Props   map[string]any
}

// Sink receives events. The hub and the HTTP handlers depend on this
// interface so tests can capture events with a fake. Implementations must not
// block and must not panic.
type Sink interface {
	Emit(Event)
}

// SinkFunc adapts a function to a Sink.
type SinkFunc func(Event)

// Emit calls f.
func (f SinkFunc) Emit(e Event) { f(e) }

// maxPeak caps the listener_peak count: a larger value is a bug, not a crowd.
const maxPeak = 100000

// allowed maps event name -> prop key -> validator. Unknown names are dropped
// whole; unknown keys or invalid values are dropped from the props.
var allowed = map[string]map[string]func(any) bool{
	RoomCreated:       {},
	RoomJoined:        {"via": oneOf("link", "public", "code")},
	TrackStarted:      {"provider": oneOf("youtube", "spotify", "other"), "source": oneOf("manual", "radio", "autoplay", "history")},
	TrackSkipped:      {"by": oneOf("host", "auto", "vote")},
	TrackLiked:        {},
	Search:            {"provider": oneOf("catalog", "youtube", "spotify", "other"), "cache_hit": isBool},
	ProviderConnected: {"provider": oneOf("spotify", "youtube", "other")},
	ListenerPeak:      {"n": isCount},
}

// Names lists every recordable event name, for docs and tests.
func Names() []string {
	return []string{RoomCreated, RoomJoined, TrackStarted, TrackSkipped, TrackLiked, Search, ProviderConnected, ListenerPeak}
}

func oneOf(values ...string) func(any) bool {
	return func(v any) bool {
		s, ok := v.(string)
		if !ok {
			return false
		}
		for _, w := range values {
			if s == w {
				return true
			}
		}
		return false
	}
}

func isBool(v any) bool { _, ok := v.(bool); return ok }

func isCount(v any) bool {
	n, ok := v.(int)
	return ok && n >= 0 && n <= maxPeak
}

// cleanProps returns the props that pass the allowlist for name, or ok=false
// when the name itself is unknown.
func cleanProps(name string, props map[string]any) (map[string]any, bool) {
	rules, known := allowed[name]
	if !known {
		return nil, false
	}
	out := make(map[string]any, len(props))
	for k, v := range props {
		if check, ok := rules[k]; ok && check(v) {
			out[k] = v
		}
	}
	return out, true
}
