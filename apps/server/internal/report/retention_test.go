package report

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/LucasSantana-Dev/cojam/server/internal/db"
)

// base is a fixed instant far in the past that the purge tests write their
// rows around.
var base = time.Date(1990, 1, 1, 12, 0, 0, 0, time.UTC)

// #319: the boundary is strict. A record created exactly at the cutoff is
// kept; one created a nanosecond earlier is purged.
func TestMemory_PurgeBefore_Boundary(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	for id, at := range map[string]time.Time{
		"older":     base.Add(-time.Nanosecond),
		"at-cutoff": base,
		"newer":     base.Add(time.Hour),
	} {
		if err := m.Create(ctx, Report{ID: id, Kind: KindRoom, CreatedAt: at}); err != nil {
			t.Fatalf("Create %s: %v", id, err)
		}
	}

	removed, err := m.PurgeBefore(ctx, base, 100)
	if err != nil || removed != 1 {
		t.Fatalf("PurgeBefore = %d, %v; want 1, nil", removed, err)
	}
	got, _ := m.Recent(ctx, 10)
	if len(got) != 2 {
		t.Fatalf("remaining = %d, want 2", len(got))
	}
	for _, r := range got {
		if r.ID == "older" {
			t.Fatal("record older than the cutoff must be purged")
		}
	}
}

// #319: one call removes at most limit records, oldest first, so a large
// backlog drains over successive sweeps instead of in one long statement.
func TestMemory_PurgeBefore_LimitTakesOldestFirst(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	// Inserted out of chronological order on purpose.
	for _, r := range []Report{
		{ID: "b", Kind: KindRoom, CreatedAt: base.Add(-2 * time.Hour)},
		{ID: "a", Kind: KindRoom, CreatedAt: base.Add(-3 * time.Hour)},
		{ID: "c", Kind: KindRoom, CreatedAt: base.Add(-1 * time.Hour)},
	} {
		_ = m.Create(ctx, r)
	}

	removed, err := m.PurgeBefore(ctx, base, 2)
	if err != nil || removed != 2 {
		t.Fatalf("PurgeBefore = %d, %v; want 2, nil", removed, err)
	}
	got, _ := m.Recent(ctx, 10)
	if len(got) != 1 || got[0].ID != "c" {
		t.Fatalf("expected only the newest (c) to survive, got %+v", got)
	}
}

func TestMemoryAudit_PurgeBefore_BoundaryAndLimit(t *testing.T) {
	ctx := context.Background()
	a := NewMemoryAudit()
	for _, act := range []Action{
		{ID: "old-2", Action: "room.kick", CreatedAt: base.Add(-2 * time.Hour)},
		{ID: "old-1", Action: "room.kick", CreatedAt: base.Add(-1 * time.Hour)},
		{ID: "at-cutoff", Action: "chat.delete", CreatedAt: base},
	} {
		_ = a.Record(ctx, act)
	}

	removed, err := a.PurgeBefore(ctx, base, 1)
	if err != nil || removed != 1 {
		t.Fatalf("first PurgeBefore = %d, %v; want 1, nil", removed, err)
	}
	removed, err = a.PurgeBefore(ctx, base, 10)
	if err != nil || removed != 1 {
		t.Fatalf("second PurgeBefore = %d, %v; want 1, nil", removed, err)
	}
	got, _ := a.RecentActions(ctx, 10)
	if len(got) != 1 || got[0].ID != "at-cutoff" {
		t.Fatalf("expected only the record at the cutoff to survive, got %+v", got)
	}
}

// openTestPool opens and migrates TEST_DATABASE_URL, or skips.
func openTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()

	// A private schema, migrated from scratch and dropped afterwards.
	// Migrating the shared public schema here would race the other test
	// packages' migrations on a fresh database (duplicate pg_type errors).
	admin, err := db.Open(ctx, dbURL)
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}
	schema := fmt.Sprintf("report_test_%d_%d", os.Getpid(), time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
	})
	u, err := url.Parse(dbURL)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()

	pool, err := db.Open(ctx, u.String())
	if err != nil {
		t.Fatalf("failed to open isolated database: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("failed to migrate database: %v", err)
	}
	return pool
}

// #319: the real DELETE honours the same strict boundary and the batch bound.
// Skips if TEST_DATABASE_URL is not set.
func TestPostgres_PurgeBefore_BoundaryAndLimit(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	ids := []string{"ret-older-2", "ret-older-1", "ret-at-cutoff", "ret-newer"}
	cleanup := func() { pool.Exec(context.Background(), "DELETE FROM reports WHERE id = ANY($1)", ids) }
	cleanup() // a killed earlier run must not leave a primary-key conflict
	t.Cleanup(cleanup)

	s := NewPostgres(pool)
	for i, at := range []time.Time{base.Add(-2 * time.Hour), base.Add(-time.Microsecond), base, base.Add(time.Hour)} {
		if err := s.Create(ctx, Report{ID: ids[i], RoomID: "ret-room", Kind: KindRoom, CreatedAt: at}); err != nil {
			t.Fatalf("Create %s: %v", ids[i], err)
		}
	}

	removed, err := s.PurgeBefore(ctx, base, 1)
	if err != nil || removed != 1 {
		t.Fatalf("bounded PurgeBefore = %d, %v; want 1, nil", removed, err)
	}
	if exists(t, pool, "reports", "ret-older-2") {
		t.Fatal("the oldest record must go first")
	}
	removed, err = s.PurgeBefore(ctx, base, 100)
	if err != nil || removed != 1 {
		t.Fatalf("second PurgeBefore = %d, %v; want 1, nil", removed, err)
	}
	for id, want := range map[string]bool{"ret-older-1": false, "ret-at-cutoff": true, "ret-newer": true} {
		if got := exists(t, pool, "reports", id); got != want {
			t.Fatalf("%s exists = %v, want %v", id, got, want)
		}
	}
}

// Skips if TEST_DATABASE_URL is not set.
func TestPostgresAudit_PurgeBefore_BoundaryAndLimit(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	ids := []string{"ret-act-older-2", "ret-act-older-1", "ret-act-at-cutoff"}
	cleanup := func() { pool.Exec(context.Background(), "DELETE FROM moderation_actions WHERE id = ANY($1)", ids) }
	cleanup()
	t.Cleanup(cleanup)

	a := NewPostgresAudit(pool)
	for i, at := range []time.Time{base.Add(-2 * time.Hour), base.Add(-time.Microsecond), base} {
		if err := a.Record(ctx, Action{ID: ids[i], RoomID: "ret-room", Action: "room.kick", CreatedAt: at}); err != nil {
			t.Fatalf("Record %s: %v", ids[i], err)
		}
	}

	removed, err := a.PurgeBefore(ctx, base, 1)
	if err != nil || removed != 1 {
		t.Fatalf("bounded PurgeBefore = %d, %v; want 1, nil", removed, err)
	}
	if exists(t, pool, "moderation_actions", "ret-act-older-2") {
		t.Fatal("the oldest record must go first")
	}
	removed, err = a.PurgeBefore(ctx, base, 100)
	if err != nil || removed != 1 {
		t.Fatalf("second PurgeBefore = %d, %v; want 1, nil", removed, err)
	}
	if !exists(t, pool, "moderation_actions", "ret-act-at-cutoff") {
		t.Fatal("record created exactly at the cutoff must be kept")
	}
}

func exists(t *testing.T, pool *pgxpool.Pool, table, id string) bool {
	t.Helper()
	var ok bool
	// table is a test constant, never input.
	if err := pool.QueryRow(context.Background(),
		"SELECT EXISTS(SELECT 1 FROM "+table+" WHERE id = $1)", id).Scan(&ok); err != nil {
		t.Fatalf("exists %s/%s: %v", table, id, err)
	}
	return ok
}

// fakePurger records calls and scripts results.
type fakePurger struct {
	mu      sync.Mutex
	calls   int
	cutoff  time.Time
	limit   int
	removed int64
	err     error
}

func (f *fakePurger) PurgeBefore(_ context.Context, cutoff time.Time, limit int) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.cutoff, f.limit = cutoff, limit
	return f.removed, f.err
}

func (f *fakePurger) snapshot() (int, time.Time, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls, f.cutoff, f.limit
}

// #319: a zero window means keep forever, the default. The sweep must not
// touch any table.
func TestRetention_DisabledNeverPurges(t *testing.T) {
	p := &fakePurger{}
	r := NewRetention(0, 100, RetentionTarget{Table: "reports", Purger: p})

	r.Sweep(context.Background(), time.Now())
	stop := r.Start(time.Millisecond)
	time.Sleep(10 * time.Millisecond)
	stop()

	if calls, _, _ := p.snapshot(); calls != 0 {
		t.Fatalf("disabled retention made %d purge calls, want 0", calls)
	}
}

// #319: one bounded call per table per sweep, cutoff = now - window.
func TestRetention_SweepPurgesEachTableOnceWithCutoff(t *testing.T) {
	reports := &fakePurger{removed: 3}
	actions := &fakePurger{removed: 0}
	var observed []string
	var observedN []int64
	r := NewRetention(30*24*time.Hour, 500,
		RetentionTarget{Table: "reports", Purger: reports},
		RetentionTarget{Table: "moderation_actions", Purger: actions},
	).WithPurgeObserver(func(table string, n int64) {
		observed = append(observed, table)
		observedN = append(observedN, n)
	})

	now := time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC)
	r.Sweep(context.Background(), now)

	for name, p := range map[string]*fakePurger{"reports": reports, "moderation_actions": actions} {
		calls, cutoff, limit := p.snapshot()
		if calls != 1 {
			t.Fatalf("%s calls = %d, want 1", name, calls)
		}
		if want := now.Add(-30 * 24 * time.Hour); !cutoff.Equal(want) {
			t.Fatalf("%s cutoff = %v, want %v", name, cutoff, want)
		}
		if limit != 500 {
			t.Fatalf("%s limit = %d, want 500", name, limit)
		}
	}
	// Only non-empty purges are observed: the counter moves by rows removed.
	if len(observed) != 1 || observed[0] != "reports" || observedN[0] != 3 {
		t.Fatalf("observed = %v %v, want [reports] [3]", observed, observedN)
	}
}

// #319: a failure on one table must not skip the others, and is retried on
// the next sweep.
func TestRetention_FailureOnOneTableDoesNotSkipOthers(t *testing.T) {
	failing := &fakePurger{err: errors.New("connection reset")}
	ok := &fakePurger{removed: 1}
	r := NewRetention(time.Hour, 10,
		RetentionTarget{Table: "reports", Purger: failing},
		RetentionTarget{Table: "moderation_actions", Purger: ok},
	)

	r.Sweep(context.Background(), time.Now())

	if calls, _, _ := ok.snapshot(); calls != 1 {
		t.Fatalf("second table calls = %d, want 1 despite the first failing", calls)
	}
}

// #319: a full batch means more rows may be past the window, so the sweep
// repeats (each DELETE still bounded) until a batch comes back short, capped
// at maxBatchesPerSweep. The observer sees the sweep total.
func TestRetention_SweepRepeatsWhileBatchIsFull(t *testing.T) {
	full := &fakePurger{removed: 10}
	var total int64
	r := NewRetention(time.Hour, 10, RetentionTarget{Table: "reports", Purger: full}).
		WithPurgeObserver(func(_ string, n int64) { total += n })

	r.Sweep(context.Background(), time.Now())

	if calls, _, _ := full.snapshot(); calls != maxBatchesPerSweep {
		t.Fatalf("calls = %d, want the cap %d while every batch is full", calls, maxBatchesPerSweep)
	}
	if want := int64(10 * maxBatchesPerSweep); total != want {
		t.Fatalf("observed total = %d, want %d", total, want)
	}
}

// #319: a non-positive batch would be an invalid LIMIT; it falls back to a
// default instead.
func TestRetention_NonPositiveBatchUsesDefault(t *testing.T) {
	p := &fakePurger{}
	NewRetention(time.Hour, 0, RetentionTarget{Table: "reports", Purger: p}).Sweep(context.Background(), time.Now())
	if _, _, limit := p.snapshot(); limit != defaultRetentionBatch {
		t.Fatalf("limit = %d, want %d", limit, defaultRetentionBatch)
	}
}

// #319: purged records must not linger in the in-memory backing array.
func TestMemory_PurgeBefore_ZeroesPurgedTail(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	_ = m.Create(ctx, Report{ID: "keep", Kind: KindRoom, CreatedAt: base})
	_ = m.Create(ctx, Report{ID: "old", Kind: KindRoom, Content: "purged text", CreatedAt: base.Add(-time.Hour)})

	if _, err := m.PurgeBefore(ctx, base, 10); err != nil {
		t.Fatal(err)
	}
	for _, r := range m.reports[:cap(m.reports)] {
		if r.Content == "purged text" {
			t.Fatal("purged report content still in the backing array")
		}
	}
}

// #319: Start sweeps immediately (a deploy more often than hourly would
// otherwise never purge), and stop returns only after the loop has exited.
func TestRetention_StartSweepsImmediatelyAndStops(t *testing.T) {
	p := &fakePurger{}
	r := NewRetention(time.Hour, 10, RetentionTarget{Table: "reports", Purger: p})

	stop := r.Start(time.Hour)
	deadline := time.Now().Add(2 * time.Second)
	for {
		if calls, _, _ := p.snapshot(); calls >= 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Start did not sweep immediately")
		}
		time.Sleep(time.Millisecond)
	}
	stop()

	calls, _, _ := p.snapshot()
	time.Sleep(5 * time.Millisecond)
	if after, _, _ := p.snapshot(); after != calls {
		t.Fatalf("purge ran after stop: %d -> %d", calls, after)
	}
}
