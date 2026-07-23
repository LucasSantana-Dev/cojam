package store

import (
	"context"
	"errors"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

func TestMemory_LoadUnknownRoom(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()

	state, err := m.Load(ctx, "unknown")
	if err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if state != nil {
		t.Fatalf("expected nil state, got %v", state)
	}
}

func TestMemory_SaveLoad_RoundTrip(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()

	original := &queue.RoomState{
		RoomID:       "room1",
		Queue:        []queue.TrackRef{},
		NowPlayingID: "",
		RadioEnabled: false,
		Version:      0,
	}

	if err := m.Save(ctx, original); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := m.Load(ctx, "room1")
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

func TestMemory_SaveLoad_WithQueue(t *testing.T) {
	m := NewMemory()
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

	if err := m.Save(ctx, original); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := m.Load(ctx, "room2")
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if len(loaded.Queue) != 1 || loaded.Queue[0].Title != "Test Song" {
		t.Fatalf("queue not preserved: %+v", loaded.Queue)
	}
}

func TestMemory_CopyIsolation_LoadMutation(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()

	original := &queue.RoomState{
		RoomID:       "room3",
		Queue:        []queue.TrackRef{},
		NowPlayingID: "",
		RadioEnabled: false,
		Version:      0,
	}

	if err := m.Save(ctx, original); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// Load and mutate the returned state
	loaded1, _ := m.Load(ctx, "room3")
	loaded1.Version = 999

	// Load again and verify the stored version is unchanged
	loaded2, _ := m.Load(ctx, "room3")
	if loaded2.Version != 0 {
		t.Fatalf("Mutation of loaded state affected stored state: version = %d, want 0", loaded2.Version)
	}
}

func TestMemory_CopyIsolation_SaveMutation(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()

	original := &queue.RoomState{
		RoomID:       "room4",
		Queue:        []queue.TrackRef{},
		NowPlayingID: "",
		RadioEnabled: false,
		Version:      0,
	}

	if err := m.Save(ctx, original); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// Mutate the original after Save
	original.Version = 777

	// Load and verify stored state is unchanged
	loaded, _ := m.Load(ctx, "room4")
	if loaded.Version != 0 {
		t.Fatalf("Mutation after Save affected stored state: version = %d, want 0", loaded.Version)
	}
}

func TestMemory_CopyIsolation_QueueMutation(t *testing.T) {
	m := NewMemory()
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

	if err := m.Save(ctx, original); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// Mutate the queue after Save
	original.Queue[0].Title = "Mutated"

	// Load and verify stored queue is unchanged
	loaded, _ := m.Load(ctx, "room5")
	if loaded.Queue[0].Title != "Original" {
		t.Fatalf("Mutation of queue after Save affected stored state: title = %q, want Original", loaded.Queue[0].Title)
	}
}

func TestMemory_MultipleRooms(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()

	room1 := &queue.RoomState{
		RoomID:       "room1",
		Queue:        []queue.TrackRef{},
		NowPlayingID: "",
		RadioEnabled: false,
		Version:      1,
	}

	room2 := &queue.RoomState{
		RoomID:       "room2",
		Queue:        []queue.TrackRef{},
		NowPlayingID: "",
		RadioEnabled: true,
		Version:      2,
	}

	if err := m.Save(ctx, room1); err != nil {
		t.Fatalf("Save room1 failed: %v", err)
	}
	if err := m.Save(ctx, room2); err != nil {
		t.Fatalf("Save room2 failed: %v", err)
	}

	loaded1, err := m.Load(ctx, "room1")
	if err != nil || loaded1.Version != 1 || loaded1.RadioEnabled != false {
		t.Fatalf("room1 mismatch: %+v", loaded1)
	}

	loaded2, err := m.Load(ctx, "room2")
	if err != nil || loaded2.Version != 2 || loaded2.RadioEnabled != true {
		t.Fatalf("room2 mismatch: %+v", loaded2)
	}
}

func TestMemory_ErrNotFound_IsCorrectError(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()

	_, err := m.Load(ctx, "nonexistent")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound via errors.Is, got %v", err)
	}
}

// Save/Load must round-trip the server-stamped timestamps (persistence is
// whole-state marshal; this pins createdAt/addedAt surviving it).
func TestMemory_SaveLoad_Timestamps(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()

	original := &queue.RoomState{
		RoomID:    "room-ts",
		Queue:     []queue.TrackRef{{ID: "t1", Title: "T", Artist: "A", Sources: queue.Sources{}, AddedBy: "u", AddedAt: 1721000000000}},
		Version:   1,
		CreatedAt: 1721000000000,
	}

	if err := m.Save(ctx, original); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := m.Load(ctx, "room-ts")
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if loaded.CreatedAt != original.CreatedAt {
		t.Fatalf("createdAt not preserved: got %d, want %d", loaded.CreatedAt, original.CreatedAt)
	}
	if len(loaded.Queue) != 1 || loaded.Queue[0].AddedAt != original.Queue[0].AddedAt {
		t.Fatalf("addedAt not preserved: %+v", loaded.Queue)
	}
}
