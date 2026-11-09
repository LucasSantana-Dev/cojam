package events

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
)

// Defaults mirror Lucky's command event buffer: bounded at 5000 rows, flushed
// at 100 rows or every 10 seconds, whichever comes first.
const (
	DefaultCapacity  = 5000
	DefaultFlushSize = 100
	DefaultInterval  = 10 * time.Second

	insertTimeout = 5 * time.Second
	// insertChunk bounds one multi-row INSERT so a backlog after a slow
	// database drains in several statements, not one huge one.
	insertChunk = 500
)

// Row is one event ready to insert: ids already hashed, props already JSON.
type Row struct {
	At        time.Time
	Name      string
	RoomHash  string // "" = NULL
	ActorHash string // "" = NULL
	Props     []byte
}

// Inserter persists rows in one statement.
type Inserter interface {
	InsertEvents(ctx context.Context, rows []Row) error
}

// Config tunes the Writer. Zero fields take the defaults.
type Config struct {
	Capacity  int
	FlushSize int
	Interval  time.Duration
}

// Writer is a bounded in-memory buffer in front of an Inserter. Emit never
// blocks, never touches the database and never panics: when the buffer is full
// the event is dropped and counted. A background goroutine flushes on size
// and on a timer.
type Writer struct {
	hasher  *Hasher
	ins     Inserter // nil = disabled
	metrics *Metrics
	logger  *slog.Logger
	cfg     Config

	mu      sync.Mutex
	buf     []Row
	closed  bool
	started bool

	wake chan struct{}
	stop chan struct{}
	done chan struct{}

	lastErrLog time.Time
}

// NewWriter builds a Writer. A nil Inserter means events are disabled: Emit
// counts them as dropped{reason="disabled"} and nothing is buffered. Call
// Start to run the flush loop and Close on shutdown.
func NewWriter(h *Hasher, ins Inserter, m *Metrics, logger *slog.Logger, cfg Config) *Writer {
	if cfg.Capacity <= 0 {
		cfg.Capacity = DefaultCapacity
	}
	if cfg.FlushSize <= 0 {
		cfg.FlushSize = DefaultFlushSize
	}
	if cfg.Interval <= 0 {
		cfg.Interval = DefaultInterval
	}
	if m == nil {
		m = NewMetrics(nil)
	}
	return &Writer{
		hasher: h, ins: ins, metrics: m, logger: logger, cfg: cfg,
		wake: make(chan struct{}, 1), stop: make(chan struct{}), done: make(chan struct{}),
	}
}

// Enabled reports whether events are persisted.
func (w *Writer) Enabled() bool { return w != nil && w.ins != nil }

// Emit validates, pseudonymises and buffers one event. It satisfies Sink.
func (w *Writer) Emit(e Event) {
	if w == nil {
		return
	}
	defer func() { _ = recover() }() // an event is never worth a crash
	if w.ins == nil {
		w.metrics.Dropped.WithLabelValues(DropDisabled).Inc()
		return
	}
	props, ok := cleanProps(e.Name, e.Props)
	if !ok {
		return // unknown name: a programming error, nothing to record
	}
	raw, err := json.Marshal(props)
	if err != nil {
		return
	}
	at := e.At
	if at.IsZero() {
		at = time.Now()
	}
	row := Row{
		At: at.UTC(), Name: e.Name, Props: raw,
		RoomHash: w.hasher.Room(e.RoomID), ActorHash: w.hasher.Actor(e.ActorID),
	}

	w.mu.Lock()
	switch {
	case w.closed:
		w.mu.Unlock()
		w.metrics.Dropped.WithLabelValues(DropDisabled).Inc()
		return
	case len(w.buf) >= w.cfg.Capacity:
		w.mu.Unlock()
		w.metrics.Dropped.WithLabelValues(DropBufferFull).Inc()
		return
	}
	w.buf = append(w.buf, row)
	full := len(w.buf) >= w.cfg.FlushSize
	w.mu.Unlock()

	if full {
		select {
		case w.wake <- struct{}{}:
		default: // a flush is already pending
		}
	}
}

// Start runs the flush loop until Close. It does nothing when disabled.
func (w *Writer) Start() {
	w.mu.Lock()
	w.started = true
	w.mu.Unlock()
	if !w.Enabled() {
		close(w.done)
		return
	}
	obs.SafeGo("events_writer", func() {
		defer close(w.done)
		t := time.NewTicker(w.cfg.Interval)
		defer t.Stop()
		for {
			select {
			case <-w.stop:
				return
			case <-t.C:
			case <-w.wake:
			}
			w.Flush(context.Background())
		}
	})
}

// Close stops the loop and flushes what is buffered, giving up after timeout
// (the rest is counted as dropped). Safe to call more than once.
func (w *Writer) Close(timeout time.Duration) {
	if w == nil {
		return
	}
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.closed = true
	started := w.started
	w.mu.Unlock()
	close(w.stop)

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if started {
		select {
		case <-w.done:
		case <-ctx.Done():
		}
	}
	if w.Enabled() {
		w.Flush(ctx)
		w.mu.Lock()
		left := len(w.buf)
		w.buf = nil
		w.mu.Unlock()
		if left > 0 {
			w.metrics.Dropped.WithLabelValues(DropDBError).Add(float64(left))
		}
	}
}

// Flush inserts everything currently buffered, in chunks. A failed chunk is
// dropped and counted (db_error): retrying forever would grow the buffer
// against a database that is down, and the events are advisory.
func (w *Writer) Flush(ctx context.Context) {
	if !w.Enabled() {
		return
	}
	for ctx.Err() == nil {
		w.mu.Lock()
		n := len(w.buf)
		if n == 0 {
			w.mu.Unlock()
			return
		}
		if n > insertChunk {
			n = insertChunk
		}
		chunk := make([]Row, n)
		copy(chunk, w.buf[:n])
		w.buf = append(w.buf[:0], w.buf[n:]...)
		w.mu.Unlock()

		ictx, cancel := context.WithTimeout(ctx, insertTimeout)
		err := w.insert(ictx, chunk)
		cancel()
		if err != nil {
			w.metrics.Dropped.WithLabelValues(DropDBError).Add(float64(len(chunk)))
			w.logInsertError(err, len(chunk))
			continue
		}
		counts := map[string]int{}
		for _, r := range chunk {
			counts[r.Name]++
		}
		for name, c := range counts {
			w.metrics.Written.WithLabelValues(name).Add(float64(c))
		}
	}
}

// insert shields the loop from a panicking Inserter.
func (w *Writer) insert(ctx context.Context, rows []Row) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = errPanic
		}
	}()
	return w.ins.InsertEvents(ctx, rows)
}

type panicError struct{}

func (panicError) Error() string { return "events inserter panicked" }

var errPanic error = panicError{}

// logInsertError logs at most once a minute so a database outage cannot flood
// the log. The error text never carries event content (rows are not logged).
func (w *Writer) logInsertError(err error, rows int) {
	if w.logger == nil || time.Since(w.lastErrLog) < time.Minute {
		return
	}
	w.lastErrLog = time.Now()
	w.logger.Warn("events_insert_failed", "rows", rows, "err", err.Error())
}

// Buffered returns the number of rows waiting to be flushed.
func (w *Writer) Buffered() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.buf)
}
