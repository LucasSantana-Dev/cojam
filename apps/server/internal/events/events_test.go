package events

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

type fakeInserter struct {
	mu    sync.Mutex
	calls [][]Row
	err   error
	block chan struct{}
}

func (f *fakeInserter) InsertEvents(ctx context.Context, rows []Row) error {
	if f.block != nil {
		select {
		case <-f.block:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.calls = append(f.calls, append([]Row(nil), rows...))
	return nil
}

func (f *fakeInserter) total() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		n += len(c)
	}
	return n
}

func (f *fakeInserter) batches() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}

func TestHasherStableKeyedAndNotTheInput(t *testing.T) {
	a := NewHasher([]byte("key-one"))
	b := NewHasher([]byte("key-one"))
	c := NewHasher([]byte("key-two"))
	id := "ABC-room-id"
	if a.Room(id) != b.Room(id) {
		t.Fatal("same key and input must give the same digest")
	}
	if a.Room(id) == c.Room(id) {
		t.Fatal("a different key must give a different digest")
	}
	if a.Room(id) == id || len(a.Room(id)) != 32 {
		t.Fatalf("digest must not be the input and must be 32 hex chars, got %q", a.Room(id))
	}
	if a.Room(id) == a.Actor(id) {
		t.Fatal("room and actor domains must not collide")
	}
	if a.Room("") != "" || a.Actor("") != "" {
		t.Fatal("empty id must stay empty (NULL)")
	}
}

func TestHasherEmptyKeyGeneratesRandomKey(t *testing.T) {
	a, b := NewHasher(nil), NewHasher(nil)
	if a.Room("x") == b.Room("x") {
		t.Fatal("two generated keys must differ")
	}
	if a.Room("x") != a.Room("x") {
		t.Fatal("a generated key is stable within the process")
	}
}

func TestEmitHashesIdsAndNeverStoresClear(t *testing.T) {
	ins := &fakeInserter{}
	w := NewWriter(NewHasher([]byte("k")), ins, nil, nil, Config{FlushSize: 1})
	w.Emit(Event{Name: RoomJoined, RoomID: "secret-room", ActorID: "user:abc", Props: map[string]any{"via": "link"}})
	w.Flush(context.Background())
	if ins.total() != 1 {
		t.Fatalf("want 1 row, got %d", ins.total())
	}
	r := ins.calls[0][0]
	if r.RoomHash == "" || r.RoomHash == "secret-room" || r.ActorHash == "" || r.ActorHash == "user:abc" {
		t.Fatalf("ids must be hashed: %+v", r)
	}
	if string(r.Props) != `{"via":"link"}` {
		t.Fatalf("props = %s", r.Props)
	}
}

func TestPropsAllowlist(t *testing.T) {
	ins := &fakeInserter{}
	w := NewWriter(NewHasher([]byte("k")), ins, nil, nil, Config{})
	w.Emit(Event{Name: Search, Props: map[string]any{
		"provider": "catalog", "cache_hit": false,
		"query": "free text", "nickname": "Ana", // not allowlisted
	}})
	w.Emit(Event{Name: TrackStarted, Props: map[string]any{"provider": "Ana's text", "source": "manual"}})
	w.Emit(Event{Name: "chat_message", Props: map[string]any{"text": "hi"}}) // unknown name
	w.Emit(Event{Name: ListenerPeak, Props: map[string]any{"n": 7}})
	w.Flush(context.Background())
	if ins.total() != 3 {
		t.Fatalf("unknown name must be dropped, got %d rows", ins.total())
	}
	got := []string{}
	for _, r := range ins.calls[0] {
		var m map[string]any
		if err := json.Unmarshal(r.Props, &m); err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(m)
		got = append(got, string(b))
	}
	want := []string{`{"cache_hit":false,"provider":"catalog"}`, `{"source":"manual"}`, `{"n":7}`}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("row %d props = %s, want %s", i, got[i], want[i])
		}
	}
}

func TestBufferBoundedAndDropsCounted(t *testing.T) {
	m := NewMetrics(nil)
	w := NewWriter(NewHasher([]byte("k")), &fakeInserter{}, m, nil, Config{Capacity: 3, FlushSize: 100})
	for i := 0; i < 5; i++ {
		w.Emit(Event{Name: TrackLiked})
	}
	if w.Buffered() != 3 {
		t.Fatalf("buffer must hold at most 3, got %d", w.Buffered())
	}
	if got := testutil.ToFloat64(m.Dropped.WithLabelValues(DropBufferFull)); got != 2 {
		t.Fatalf("buffer_full drops = %v, want 2", got)
	}
}

func TestFlushOnSize(t *testing.T) {
	ins := &fakeInserter{}
	m := NewMetrics(nil)
	w := NewWriter(NewHasher([]byte("k")), ins, m, nil, Config{FlushSize: 4, Interval: time.Hour})
	w.Start()
	defer w.Close(time.Second)
	for i := 0; i < 3; i++ {
		w.Emit(Event{Name: TrackLiked})
	}
	time.Sleep(50 * time.Millisecond)
	if ins.total() != 0 {
		t.Fatal("must not flush below the size threshold")
	}
	w.Emit(Event{Name: TrackLiked})
	waitFor(t, func() bool { return ins.total() == 4 })
	waitFor(t, func() bool { return testutil.ToFloat64(m.Written.WithLabelValues(TrackLiked)) == 4 })
}

func TestFlushOnTime(t *testing.T) {
	ins := &fakeInserter{}
	w := NewWriter(NewHasher([]byte("k")), ins, nil, nil, Config{FlushSize: 100, Interval: 20 * time.Millisecond})
	w.Start()
	defer w.Close(time.Second)
	w.Emit(Event{Name: RoomCreated})
	waitFor(t, func() bool { return ins.total() == 1 })
}

func TestSingleMultiRowInsertPerChunk(t *testing.T) {
	ins := &fakeInserter{}
	w := NewWriter(NewHasher([]byte("k")), ins, nil, nil, Config{FlushSize: 1000})
	for i := 0; i < 120; i++ {
		w.Emit(Event{Name: TrackLiked})
	}
	w.Flush(context.Background())
	if ins.batches() != 1 || ins.total() != 120 {
		t.Fatalf("want one insert of 120 rows, got %d inserts / %d rows", ins.batches(), ins.total())
	}
}

func TestDBErrorDropsAndCounts(t *testing.T) {
	m := NewMetrics(nil)
	ins := &fakeInserter{err: errors.New("db down")}
	w := NewWriter(NewHasher([]byte("k")), ins, m, nil, Config{})
	w.Emit(Event{Name: TrackLiked})
	w.Emit(Event{Name: TrackLiked})
	w.Flush(context.Background())
	if got := testutil.ToFloat64(m.Dropped.WithLabelValues(DropDBError)); got != 2 {
		t.Fatalf("db_error drops = %v, want 2", got)
	}
	if w.Buffered() != 0 {
		t.Fatal("a failed chunk must not be retried forever")
	}
}

func TestDisabledCountsAndNeverBuffers(t *testing.T) {
	m := NewMetrics(nil)
	w := NewWriter(NewHasher([]byte("k")), nil, m, nil, Config{})
	w.Start()
	w.Emit(Event{Name: TrackLiked})
	w.Emit(Event{Name: TrackLiked})
	w.Close(time.Second)
	if w.Enabled() || w.Buffered() != 0 {
		t.Fatal("disabled writer must not buffer")
	}
	if got := testutil.ToFloat64(m.Dropped.WithLabelValues(DropDisabled)); got != 2 {
		t.Fatalf("disabled drops = %v, want 2", got)
	}
}

func TestCloseFlushesWithinTimeout(t *testing.T) {
	ins := &fakeInserter{}
	w := NewWriter(NewHasher([]byte("k")), ins, nil, nil, Config{FlushSize: 1000, Interval: time.Hour})
	w.Start()
	w.Emit(Event{Name: RoomCreated})
	w.Emit(Event{Name: RoomCreated})
	w.Close(time.Second)
	if ins.total() != 2 {
		t.Fatalf("shutdown must flush the buffer, got %d rows", ins.total())
	}
	w.Close(time.Second) // idempotent
}

func TestCloseGivesUpOnHungDatabase(t *testing.T) {
	m := NewMetrics(nil)
	ins := &fakeInserter{block: make(chan struct{})}
	w := NewWriter(NewHasher([]byte("k")), ins, m, nil, Config{FlushSize: 1000, Interval: time.Hour})
	w.Start()
	w.Emit(Event{Name: RoomCreated})
	start := time.Now()
	w.Close(100 * time.Millisecond)
	if time.Since(start) > 2*time.Second {
		t.Fatal("Close must respect its timeout")
	}
	if got := testutil.ToFloat64(m.Dropped.WithLabelValues(DropDBError)); got != 1 {
		t.Fatalf("unflushed row must be counted as dropped, got %v", got)
	}
}

func TestEmitNeverBlocksOrPanicsOnNilWriter(t *testing.T) {
	var w *Writer
	w.Emit(Event{Name: RoomCreated})
	w.Close(time.Millisecond)
}

func TestPurgeSQLIsBoundedAndByAge(t *testing.T) {
	for _, frag := range []string{"DELETE FROM product_events", "at < $1", "ORDER BY at", "LIMIT $2"} {
		if !contains(PurgeSQL, frag) {
			t.Fatalf("PurgeSQL missing %q", frag)
		}
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
