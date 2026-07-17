package store

import (
	"context"
	"errors"
	"os"
	"testing"

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

	track := queue.TrackRef{
		ID:      "track1",
		Title:   "Test Song",
		Artist:  "Test Artist",
		Sources: queue.Sources{},
		AddedBy: "user1",
	}

	original.Queue = append(original.Queue, track)
	original.Version = 1

	if err := store.Save(ctx, original); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := store.Load(ctx, "room2")
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if len(loaded.Queue) != 1 || loaded.Queue[0].Title != "Test Song" {
		t.Fatalf("queue not preserved: %+v", loaded.Queue)
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
