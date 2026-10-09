package hub

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/events"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// fakeSink captures events in order.
type fakeSink struct {
	mu  sync.Mutex
	got []events.Event
}

func (f *fakeSink) Emit(e events.Event) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, e)
}

func (f *fakeSink) named(name string) []events.Event {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []events.Event
	for _, e := range f.got {
		if e.Name == name {
			out = append(out, e)
		}
	}
	return out
}

func (f *fakeSink) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = nil
}

func eventsHub(t *testing.T) (*Hub, *fakeSink) {
	t.Helper()
	sink := &fakeSink{}
	return NewHub(nil).WithSync(true).WithEvents(sink), sink
}

func evAddTrack(t *testing.T, h *Hub, title string, durationMs int64, withYT bool) {
	t.Helper()
	src := `{}`
	if withYT {
		src = `{"youtube":{"videoId":"v","confidence":1}}`
	}
	body := `{"roomId":"` + rolesRoom + `","track":{"title":"` + title + `","artist":"A","durationMs":` + evItoa(durationMs) + `,"sources":` + src + `,"addedBy":"x"}}`
	if err := rolesRPC(h, "queue.add", body, "c-o", "owner"); err != nil {
		t.Fatalf("queue.add: %v", err)
	}
}

func evItoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

func TestEvents_RoomCreatedAndJoined(t *testing.T) {
	h, sink := eventsHub(t)
	rolesJoin(t, h, "c-o", "owner")
	rolesJoin(t, h, "c-b", "bob")
	if n := len(sink.named(events.RoomCreated)); n != 1 {
		t.Fatalf("room_created emitted %d times, want 1", n)
	}
	joined := sink.named(events.RoomJoined)
	if len(joined) != 2 {
		t.Fatalf("room_joined emitted %d times, want 2 (one per new member)", len(joined))
	}
	if joined[0].ActorID != "user:owner" || joined[0].RoomID != rolesRoom {
		t.Fatalf("joined = %+v", joined[0])
	}
	if _, has := joined[0].Props["via"]; has {
		t.Fatal("via is not knowable server-side and must be omitted")
	}
	// A second room.join of the same pair is a resubscribe, not a new join.
	rolesJoin(t, h, "c-o", "owner")
	if n := len(sink.named(events.RoomJoined)); n != 2 {
		t.Fatalf("re-join emitted again: %d", n)
	}
	// A guest connection is keyed by connection id.
	h.Join("guest", rolesRoom)
	if last := sink.named(events.RoomJoined); last[len(last)-1].ActorID != "client:guest" {
		t.Fatalf("guest actor = %q", last[len(last)-1].ActorID)
	}
}

func TestEvents_TrackStartedSources(t *testing.T) {
	h, sink := eventsHub(t)
	rolesJoin(t, h, "c-o", "owner")

	evAddTrack(t, h, "one", 200_000, true) // idle room: someone picked it
	evAddTrack(t, h, "two", 200_000, false)
	started := sink.named(events.TrackStarted)
	if len(started) != 1 || started[0].Props["source"] != "manual" || started[0].Props["provider"] != "youtube" {
		t.Fatalf("first start = %+v", started)
	}
	if started[0].RoomID != rolesRoom || started[0].ActorID != "" {
		t.Fatalf("track_started carries room only, got %+v", started[0])
	}

	first := rolesState(t, h).Queue[0].ID
	if err := rolesRPC(h, "now_playing.advance", `{"roomId":"`+rolesRoom+`","afterId":"`+first+`"}`, "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	started = sink.named(events.TrackStarted)
	if len(started) != 2 || started[1].Props["source"] != "autoplay" || started[1].Props["provider"] != "other" {
		t.Fatalf("second start = %+v", started)
	}

	// History re-add onto an idle room.
	second := rolesState(t, h).Queue[0].ID
	if err := rolesRPC(h, "now_playing.advance", `{"roomId":"`+rolesRoom+`","afterId":"`+second+`"}`, "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	if rolesState(t, h).NowPlayingID != "" {
		t.Fatal("room should be idle")
	}
	sink.reset()
	if err := rolesRPC(h, "history.readd", `{"roomId":"`+rolesRoom+`","trackId":"`+first+`"}`, "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	started = sink.named(events.TrackStarted)
	if len(started) != 1 || started[0].Props["source"] != "history" {
		t.Fatalf("history start = %+v", started)
	}
}

func TestEvents_TrackStartedRadioOrigin(t *testing.T) {
	h, sink := eventsHub(t)
	rolesJoin(t, h, "c-o", "owner")
	sink.reset()
	_, err := h.mutate(rolesRoom, func(s *queue.RoomState) error {
		s.Add(queue.TrackRef{Title: "r", Artist: "A", Origin: queue.OriginRadio})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	started := sink.named(events.TrackStarted)
	if len(started) != 1 || started[0].Props["source"] != "radio" {
		t.Fatalf("radio start = %+v", started)
	}
}

func TestEvents_TrackSkipped(t *testing.T) {
	h, sink := eventsHub(t)
	rolesJoin(t, h, "c-o", "owner")
	evAddTrack(t, h, "one", 200_000, true)
	evAddTrack(t, h, "two", 200_000, true)
	evAddTrack(t, h, "three", 200_000, true)
	adv := func(id string) {
		t.Helper()
		if err := rolesRPC(h, "now_playing.advance", `{"roomId":"`+rolesRoom+`","afterId":"`+id+`"}`, "c-o", "owner"); err != nil {
			t.Fatal(err)
		}
	}

	// Skip at the start: by=host, attributed to the caller's key.
	adv(rolesState(t, h).NowPlayingID)
	sk := sink.named(events.TrackSkipped)
	if len(sk) != 1 || sk[0].Props["by"] != "host" || sk[0].ActorID != "user:owner" || sk[0].RoomID != rolesRoom {
		t.Fatalf("skip = %+v", sk)
	}

	// Natural end: the transport is at the end, so no skip.
	room := mustRoom(t, h, rolesRoom)
	room.mu.Lock()
	room.State.Transport = &queue.TransportState{State: "playing", PositionMs: 199_000, UpdatedAtServerMs: time.Now().UnixMilli()}
	room.mu.Unlock()
	adv(rolesState(t, h).NowPlayingID)
	if n := len(sink.named(events.TrackSkipped)); n != 1 {
		t.Fatalf("a track that finished must not count as skipped, got %d skips", n)
	}

	// A stale or repeated advance is a no-op and records nothing.
	adv("not-playing")
	if n := len(sink.named(events.TrackSkipped)); n != 1 {
		t.Fatalf("no-op advance recorded a skip: %d", n)
	}

	// Automatic skip of a track that cannot play: by=auto, no actor.
	cur := rolesState(t, h).NowPlayingID
	if _, err := h.advanceAfter(rolesRoom, cur, false); err != nil {
		t.Fatal(err)
	}
	sk = sink.named(events.TrackSkipped)
	if len(sk) != 2 || sk[1].Props["by"] != "auto" || sk[1].ActorID != "" {
		t.Fatalf("auto skip = %+v", sk)
	}
}

func TestEvents_TrackLiked(t *testing.T) {
	h, sink := eventsHub(t)
	h.wootPublishFn = func(string, []byte) error { return nil }
	rolesJoin(t, h, "c-o", "owner")
	if _, err := h.handleRPC("reaction.woot", wootReq(rolesRoom), "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	liked := sink.named(events.TrackLiked)
	if len(liked) != 1 || liked[0].ActorID != "user:owner" || liked[0].RoomID != rolesRoom {
		t.Fatalf("liked = %+v", liked)
	}
	// A rejected woot (not a member) records nothing.
	if _, err := h.handleRPC("reaction.woot", wootReq(rolesRoom), "stranger", ""); err == nil {
		t.Fatal("stranger accepted")
	}
	if n := len(sink.named(events.TrackLiked)); n != 1 {
		t.Fatalf("rejected woot recorded: %d", n)
	}
}

func TestEvents_SearchCarriesNoText(t *testing.T) {
	h, sink := eventsHub(t)
	h.WithSearcher(func(ctx context.Context, q string, prefer []string, limit int) ([]SearchResult, error) {
		return []SearchResult{{Title: "t"}}, nil
	})
	if _, err := h.handleRPC("track.search", []byte(`{"query":"my private song"}`), "c-1", ""); err != nil {
		t.Fatal(err)
	}
	got := sink.named(events.Search)
	if len(got) != 1 || got[0].Props["provider"] != "catalog" || got[0].Props["cache_hit"] != false {
		t.Fatalf("search = %+v", got)
	}
	b, _ := json.Marshal(got[0])
	if strings.Contains(string(b), "private") {
		t.Fatalf("search text leaked into the event: %s", b)
	}
	// Blank query is rejected before any search happens.
	if _, err := h.handleRPC("track.search", []byte(`{"query":"  "}`), "c-1", ""); err == nil {
		t.Fatal("blank query accepted")
	}
	if n := len(sink.named(events.Search)); n != 1 {
		t.Fatalf("rejected search recorded: %d", n)
	}
}

func TestEvents_NilSinkIsOff(t *testing.T) {
	h := NewHub(nil).WithSync(true)
	rolesJoin(t, h, "c-o", "owner")
	evAddTrack(t, h, "one", 200_000, true)
	stop := h.StartPeakFlusher() // must not start anything or panic
	stop()
}

func TestPeakTracker(t *testing.T) {
	var p peakTracker
	t0 := time.Date(2026, 10, 9, 14, 10, 0, 0, time.UTC)
	if _, done := p.observe("r", 1, t0); done {
		t.Fatal("first observation finishes nothing")
	}
	p.observe("r", 3, t0.Add(5*time.Minute))
	p.observe("r", 2, t0.Add(20*time.Minute)) // lower: peak stays 3
	if got := p.drain(t0.Add(30*time.Minute), false); len(got) != 0 {
		t.Fatalf("the hour is not over yet: %+v", got)
	}
	// A join in the next hour closes the previous one for that room.
	f, done := p.observe("r", 1, t0.Add(55*time.Minute))
	if !done || f.n != 3 || !f.hour.Equal(time.Date(2026, 10, 9, 14, 0, 0, 0, time.UTC)) {
		t.Fatalf("rollover = %+v done=%v", f, done)
	}
	// An idle room is found by the flusher once its hour ended.
	p.observe("idle", 4, t0)
	got := p.drain(t0.Add(2*time.Hour), false)
	if len(got) != 2 {
		t.Fatalf("drain after the hour = %+v", got)
	}
	if left := p.drain(t0, true); len(left) != 0 {
		t.Fatalf("drained entries must be removed: %+v", left)
	}
}

func TestEvents_ListenerPeakOncePerRoomPerHour(t *testing.T) {
	h, sink := eventsHub(t)
	t0 := time.Date(2026, 10, 9, 14, 10, 0, 0, time.UTC)
	h.peaks.observe("R", 2, t0)
	h.peaks.observe("R", 5, t0.Add(time.Minute))
	h.flushPeaks(t0.Add(10*time.Minute), false) // same hour: nothing yet
	if len(sink.named(events.ListenerPeak)) != 0 {
		t.Fatal("peak emitted before its hour ended")
	}
	h.flushPeaks(t0.Add(time.Hour), false)
	h.flushPeaks(t0.Add(2*time.Hour), false) // already drained: no duplicate
	peaks := sink.named(events.ListenerPeak)
	if len(peaks) != 1 || peaks[0].Props["n"] != 5 || peaks[0].RoomID != "R" || peaks[0].ActorID != "" {
		t.Fatalf("peaks = %+v", peaks)
	}
	if !peaks[0].At.Equal(time.Date(2026, 10, 9, 14, 0, 0, 0, time.UTC)) {
		t.Fatalf("peak is stamped with the hour it describes, got %v", peaks[0].At)
	}
}

// memInserter collects hashed rows from a real Writer.
type memInserter struct {
	mu   sync.Mutex
	rows []events.Row
}

func (m *memInserter) InsertEvents(_ context.Context, rows []events.Row) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows = append(m.rows, rows...)
	return nil
}

// The whole path with the real Writer: no clear room id, user id, nickname,
// connection id or search text may appear in any stored field.
func TestEvents_NothingIdentifyingReachesTheRows(t *testing.T) {
	ins := &memInserter{}
	w := events.NewWriter(events.NewHasher([]byte("hmac-for-tests")), ins, nil, nil, events.Config{})
	h := NewHub(nil).WithSync(true).WithEvents(w)
	h.wootPublishFn = func(string, []byte) error { return nil }
	h.WithSearcher(func(context.Context, string, []string, int) ([]SearchResult, error) { return nil, nil })

	rolesJoin(t, h, "conn-XYZ", "uid-777")
	if err := rolesRPC(h, "queue.add", `{"roomId":"`+rolesRoom+`","track":{"title":"Titulo Privado","artist":"Artista","sources":{},"addedBy":"Apelido"}}`, "conn-XYZ", "uid-777"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.handleRPC("reaction.woot", wootReq(rolesRoom), "conn-XYZ", "uid-777"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.handleRPC("track.search", []byte(`{"query":"consulta privada"}`), "conn-XYZ", "uid-777"); err != nil {
		t.Fatal(err)
	}
	w.Flush(context.Background())

	if len(ins.rows) < 4 {
		t.Fatalf("expected the flow to record events, got %d", len(ins.rows))
	}
	for _, r := range ins.rows {
		all := r.Name + "|" + r.RoomHash + "|" + r.ActorHash + "|" + string(r.Props)
		for _, clear := range []string{rolesRoom, "uid-777", "conn-XYZ", "Apelido", "Titulo", "Artista", "consulta"} {
			if strings.Contains(all, clear) {
				t.Fatalf("row leaks %q: %s", clear, all)
			}
		}
	}
}
