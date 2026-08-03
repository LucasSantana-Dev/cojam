package store

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/db"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// TestStoreInterface runs interface conformance tests against both Memory and Postgres.
// Postgres tests skip if TEST_DATABASE_URL is not set.
func TestStoreInterface(t *testing.T) {
	tests := []struct {
		name  string
		store func(tb testing.TB) Store
	}{
		{
			name: "Memory",
			store: func(tb testing.TB) Store {
				return NewMemory()
			},
		},
		{
			name: "Postgres",
			store: func(tb testing.TB) Store {
				dbURL := os.Getenv("TEST_DATABASE_URL")
				if dbURL == "" {
					tb.Skip("TEST_DATABASE_URL not set")
				}

				ctx := context.Background()
				pool, err := db.Open(ctx, dbURL)
				if err != nil {
					tb.Fatalf("failed to open database: %v", err)
				}
				tb.Cleanup(func() { pool.Close() })

				if err := db.Migrate(ctx, pool); err != nil {
					tb.Fatalf("failed to migrate database: %v", err)
				}

				// Truncate rooms table to start fresh
				if _, err := pool.Exec(ctx, "TRUNCATE TABLE rooms"); err != nil {
					tb.Fatalf("failed to truncate rooms table: %v", err)
				}

				return NewPostgres(pool)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Run("LoadUnknownRoom", func(t *testing.T) {
				testLoadUnknownRoom(t, tt.store(t))
			})
			t.Run("SaveLoadRoundTrip", func(t *testing.T) {
				testSaveLoadRoundTrip(t, tt.store(t))
			})
			t.Run("SaveLoadWithQueue", func(t *testing.T) {
				testSaveLoadWithQueue(t, tt.store(t))
			})
			t.Run("CopyIsolationLoadMutation", func(t *testing.T) {
				testCopyIsolationLoadMutation(t, tt.store(t))
			})
			t.Run("CopyIsolationSaveMutation", func(t *testing.T) {
				testCopyIsolationSaveMutation(t, tt.store(t))
			})
			t.Run("CopyIsolationQueueMutation", func(t *testing.T) {
				testCopyIsolationQueueMutation(t, tt.store(t))
			})
			t.Run("DeleteIdleRoomsNilProtected", func(t *testing.T) {
				testDeleteIdleRoomsNilProtected(t, tt.store(t))
			})
		})
	}
}

// TestPostgresStaleWriteRejection tests the version-guarded upsert feature specific to Postgres.
// This test skips if TEST_DATABASE_URL is not set.
func TestPostgresStaleWriteRejection(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}

	ctx := context.Background()
	pool, err := db.Open(ctx, dbURL)
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}
	defer pool.Close()

	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("failed to migrate database: %v", err)
	}

	if _, err := pool.Exec(ctx, "TRUNCATE TABLE rooms"); err != nil {
		t.Fatalf("failed to truncate rooms table: %v", err)
	}

	store := NewPostgres(pool)
	testStaleWriteRejection(t, store)
}

// TestPostgresVersionGuardObserver verifies the WithVersionGuardObserver hook
// fires exactly when the upsert's RowsAffected is 0 (stale write dropped) and
// not on accepted writes. Skips if TEST_DATABASE_URL is not set.
func TestPostgresVersionGuardObserver(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}

	ctx := context.Background()
	pool, err := db.Open(ctx, dbURL)
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}
	defer pool.Close()

	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("failed to migrate database: %v", err)
	}

	if _, err := pool.Exec(ctx, "TRUNCATE TABLE rooms"); err != nil {
		t.Fatalf("failed to truncate rooms table: %v", err)
	}

	rejected := 0
	store := NewPostgres(pool).WithVersionGuardObserver(func() { rejected++ })

	fresh := &queue.RoomState{RoomID: "room-vg", Queue: []queue.TrackRef{}, Version: 5}
	if err := store.Save(ctx, fresh); err != nil {
		t.Fatalf("Save fresh failed: %v", err)
	}
	if rejected != 0 {
		t.Fatalf("observer fired on an accepted insert, rejected = %d", rejected)
	}

	stale := &queue.RoomState{RoomID: "room-vg", Queue: []queue.TrackRef{}, Version: 3}
	if err := store.Save(ctx, stale); err != nil {
		t.Fatalf("stale Save must still return nil (RFC-0001), got %v", err)
	}
	if rejected != 1 {
		t.Fatalf("observer must fire once for the version-guard rejection, rejected = %d", rejected)
	}
}

func testLoadUnknownRoom(t *testing.T, store Store) {
	ctx := context.Background()
	state, err := store.Load(ctx, "unknown")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if state != nil {
		t.Fatalf("expected nil state, got %v", state)
	}
}

func testSaveLoadRoundTrip(t *testing.T, store Store) {
	ctx := context.Background()
	original := &queue.RoomState{
		RoomID:       "room1",
		Queue:        []queue.TrackRef{},
		NowPlayingID: "",
		RadioEnabled: false,
		Version:      0,
	}

	if err := store.Save(ctx, original); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := store.Load(ctx, "room1")
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if loaded == nil {
		t.Fatalf("loaded state is nil")
	}

	if loaded.RoomID != original.RoomID || loaded.Version != original.Version || loaded.RadioEnabled != original.RadioEnabled {
		t.Fatalf("loaded state does not match original: %+v vs %+v", loaded, original)
	}
}

func testSaveLoadWithQueue(t *testing.T, store Store) {
	ctx := context.Background()
	original := &queue.RoomState{
		RoomID:       "room2",
		Queue:        []queue.TrackRef{},
		NowPlayingID: "",
		RadioEnabled: false,
		Version:      0,
	}

	// Two distinct tracks so ordering is provable, plus now-playing + radio so
	// the full playback state round-trips (not just a single-item queue).
	original.Queue = append(original.Queue,
		queue.TrackRef{ID: "track1", Title: "First Song", Artist: "Artist A", Sources: queue.Sources{}, AddedBy: "user1"},
		queue.TrackRef{ID: "track2", Title: "Second Song", Artist: "Artist B", Sources: queue.Sources{}, AddedBy: "user2"},
	)
	original.NowPlayingID = "track2"
	original.RadioEnabled = true
	original.Version = 1

	if err := store.Save(ctx, original); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := store.Load(ctx, "room2")
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if len(loaded.Queue) != 2 {
		t.Fatalf("queue length not preserved: got %d, want 2 (%+v)", len(loaded.Queue), loaded.Queue)
	}
	if loaded.Queue[0].ID != "track1" || loaded.Queue[1].ID != "track2" {
		t.Fatalf("queue ordering not preserved: got [%s, %s], want [track1, track2]", loaded.Queue[0].ID, loaded.Queue[1].ID)
	}
	if loaded.Queue[0].Title != "First Song" || loaded.Queue[1].Title != "Second Song" {
		t.Fatalf("track fields not preserved: %+v", loaded.Queue)
	}
	if loaded.NowPlayingID != "track2" {
		t.Fatalf("now-playing not preserved: got %q, want track2", loaded.NowPlayingID)
	}
	if !loaded.RadioEnabled {
		t.Fatalf("radio flag not preserved: got false, want true")
	}
}

func testCopyIsolationLoadMutation(t *testing.T, store Store) {
	ctx := context.Background()
	original := &queue.RoomState{
		RoomID:       "room3",
		Queue:        []queue.TrackRef{},
		NowPlayingID: "",
		RadioEnabled: false,
		Version:      0,
	}

	if err := store.Save(ctx, original); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded1, _ := store.Load(ctx, "room3")
	loaded1.Version = 999

	loaded2, _ := store.Load(ctx, "room3")
	if loaded2.Version != 0 {
		t.Fatalf("Mutation of loaded state affected stored state: version = %d, want 0", loaded2.Version)
	}
}

func testCopyIsolationSaveMutation(t *testing.T, store Store) {
	ctx := context.Background()
	original := &queue.RoomState{
		RoomID:       "room4",
		Queue:        []queue.TrackRef{},
		NowPlayingID: "",
		RadioEnabled: false,
		Version:      0,
	}

	if err := store.Save(ctx, original); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	original.Version = 777

	loaded, _ := store.Load(ctx, "room4")
	if loaded.Version != 0 {
		t.Fatalf("Mutation after Save affected stored state: version = %d, want 0", loaded.Version)
	}
}

func testCopyIsolationQueueMutation(t *testing.T, store Store) {
	ctx := context.Background()
	original := &queue.RoomState{
		RoomID:       "room5",
		Queue:        []queue.TrackRef{},
		NowPlayingID: "",
		RadioEnabled: false,
		Version:      0,
	}

	track := queue.TrackRef{
		ID:      "track1",
		Title:   "Original",
		Artist:  "Artist",
		Sources: queue.Sources{},
		AddedBy: "user1",
	}
	original.Queue = append(original.Queue, track)

	if err := store.Save(ctx, original); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	original.Queue[0].Title = "Mutated"

	loaded, _ := store.Load(ctx, "room5")
	if loaded.Queue[0].Title != "Original" {
		t.Fatalf("Mutation of queue after Save affected stored state: title = %q, want Original", loaded.Queue[0].Title)
	}
}

// #169: a nil protected set is an error on every implementation — the
// membership gate must be stated explicitly, never defaulted.
func testDeleteIdleRoomsNilProtected(t *testing.T, store Store) {
	_, err := store.DeleteIdleRooms(context.Background(), time.Now(), nil)
	if !errors.Is(err, ErrNilProtected) {
		t.Fatalf("nil protected set must return ErrNilProtected, got %v", err)
	}
}

// TestPostgresDeleteIdleRooms exercises the real delete: rows older than the
// cutoff are removed, protected room ids survive however old their rows are,
// rows inside the TTL survive, and the returned count is accurate. Skips if
// TEST_DATABASE_URL is not set.
func TestPostgresDeleteIdleRooms(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}

	ctx := context.Background()
	pool, err := db.Open(ctx, dbURL)
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}
	defer pool.Close()

	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("failed to migrate database: %v", err)
	}

	if _, err := pool.Exec(ctx, "TRUNCATE TABLE rooms"); err != nil {
		t.Fatalf("failed to truncate rooms table: %v", err)
	}

	store := NewPostgres(pool)
	for _, id := range []string{"old-memberless", "old-protected", "fresh"} {
		if err := store.Save(ctx, &queue.RoomState{RoomID: id, Queue: []queue.TrackRef{}, Version: 1}); err != nil {
			t.Fatalf("Save %s: %v", id, err)
		}
	}
	// Age two rows past the TTL; "fresh" keeps a current updated_at.
	if _, err := pool.Exec(ctx,
		"UPDATE rooms SET updated_at = now() - interval '2 hours' WHERE room_id IN ('old-memberless', 'old-protected')"); err != nil {
		t.Fatalf("failed to age rows: %v", err)
	}

	removed, err := store.DeleteIdleRooms(ctx, time.Now().Add(-time.Hour), map[string]struct{}{"old-protected": {}})
	if err != nil {
		t.Fatalf("DeleteIdleRooms: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1 (only old-memberless)", removed)
	}

	var remaining int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM rooms").Scan(&remaining); err != nil {
		t.Fatalf("count: %v", err)
	}
	if remaining != 2 {
		t.Fatalf("remaining rows = %d, want 2 (old-protected + fresh)", remaining)
	}
	if _, err := store.Load(ctx, "old-protected"); err != nil {
		t.Fatalf("protected room must survive however old its row is: %v", err)
	}
	if _, err := store.Load(ctx, "fresh"); err != nil {
		t.Fatalf("room inside the TTL must survive: %v", err)
	}

	// An allocated empty set is a legitimate "nothing to protect" answer.
	removed, err = store.DeleteIdleRooms(ctx, time.Now().Add(-time.Hour), map[string]struct{}{})
	if err != nil {
		t.Fatalf("DeleteIdleRooms (empty protected): %v", err)
	}
	if removed != 1 {
		t.Fatalf("second sweep removed = %d, want 1 (old-protected now unprotected)", removed)
	}
}

func testStaleWriteRejection(t *testing.T, store Store) {
	ctx := context.Background()

	state1 := &queue.RoomState{
		RoomID:       "room6",
		Queue:        []queue.TrackRef{},
		NowPlayingID: "",
		RadioEnabled: false,
		Version:      5,
	}

	if err := store.Save(ctx, state1); err != nil {
		t.Fatalf("Save version 5 failed: %v", err)
	}

	staleState := &queue.RoomState{
		RoomID:       "room6",
		Queue:        []queue.TrackRef{},
		NowPlayingID: "changed",
		RadioEnabled: true,
		Version:      3,
	}

	if err := store.Save(ctx, staleState); err != nil {
		t.Fatalf("Save version 3 failed: %v", err)
	}

	loaded, _ := store.Load(ctx, "room6")
	if loaded.Version != 5 {
		t.Fatalf("Stale write was accepted: version = %d, want 5", loaded.Version)
	}
	if loaded.NowPlayingID != "" {
		t.Fatalf("Stale write mutated state: NowPlayingID = %q, want empty", loaded.NowPlayingID)
	}
	if loaded.RadioEnabled != false {
		t.Fatalf("Stale write mutated state: RadioEnabled = %v, want false", loaded.RadioEnabled)
	}
}
