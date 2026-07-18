package hub

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/db"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

// TestHubPersistenceAcrossRestart proves room state survives a hub restart
// by persisting through PostgreSQL. Skips if TEST_DATABASE_URL is unset.
func TestHubPersistenceAcrossRestart(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL unset, skipping persistence test")
	}

	// Open and migrate a real database
	pool, err := db.Open(context.Background(), dbURL)
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}
	defer pool.Close()

	if err := db.Migrate(context.Background(), pool); err != nil {
		t.Fatalf("failed to migrate database: %v", err)
	}

	// Use a unique room ID per test to avoid conflicts
	roomID := fmt.Sprintf("test_persist_%d", os.Getpid())

	// Clean up the room if it exists from a prior failed run
	defer pool.Exec(context.Background(), "DELETE FROM rooms WHERE room_id = $1", roomID)

	// Create first hub with postgres store
	pgStore1 := store.NewPostgres(pool)
	hub1 := NewHub(nil).WithStore(pgStore1)

	// Join the room and add two tracks via HandleRPC (mutating methods require membership)
	joinRes, err := hub1.HandleRPC("room.join", []byte(fmt.Sprintf(`{"roomId":"%s","name":"alice"}`, roomID)), "")
	if err != nil {
		t.Fatalf("room.join failed: %v", err)
	}
	var state1 queue.RoomState
	if err := json.Unmarshal(joinRes, &state1); err != nil {
		t.Fatalf("failed to unmarshal join response: %v", err)
	}

	// Add first track
	addRes, err := hub1.HandleRPC("queue.add", []byte(fmt.Sprintf(`{"roomId":"%s","track":{"title":"Song A","artist":"Artist A","sources":{},"addedBy":"alice"}}`, roomID)), "")
	if err != nil {
		t.Fatalf("queue.add track 1 failed: %v", err)
	}
	if err := json.Unmarshal(addRes, &state1); err != nil {
		t.Fatalf("failed to unmarshal add response: %v", err)
	}
	track1ID := state1.Queue[0].ID

	// Add second track
	addRes, err = hub1.HandleRPC("queue.add", []byte(fmt.Sprintf(`{"roomId":"%s","track":{"title":"Song B","artist":"Artist B","sources":{},"addedBy":"alice"}}`, roomID)), "")
	if err != nil {
		t.Fatalf("queue.add track 2 failed: %v", err)
	}
	if err := json.Unmarshal(addRes, &state1); err != nil {
		t.Fatalf("failed to unmarshal add response: %v", err)
	}
	track2ID := state1.Queue[1].ID

	// Set now playing to the second track
	npRes, err := hub1.HandleRPC("now_playing.set", []byte(fmt.Sprintf(`{"roomId":"%s","trackId":"%s"}`, roomID, track2ID)), "")
	if err != nil {
		t.Fatalf("now_playing.set failed: %v", err)
	}
	if err := json.Unmarshal(npRes, &state1); err != nil {
		t.Fatalf("failed to unmarshal now_playing response: %v", err)
	}

	// Verify hub1 state before restart
	if len(state1.Queue) != 2 {
		t.Fatalf("hub1 queue length is %d, want 2", len(state1.Queue))
	}
	if state1.NowPlayingID != track2ID {
		t.Fatalf("hub1 NowPlayingID is %s, want %s", state1.NowPlayingID, track2ID)
	}

	// Create second hub (fresh instance) with postgres store on same database
	pgStore2 := store.NewPostgres(pool)
	hub2 := NewHub(nil).WithStore(pgStore2)

	// Load the room in hub2 (read-through load from store)
	room2 := hub2.GetOrCreateRoom(roomID)
	if room2 == nil || room2.State == nil {
		t.Fatalf("hub2 failed to load room from store")
	}

	state2 := room2.State

	// Verify persistence: same queue length and content
	if len(state2.Queue) != 2 {
		t.Fatalf("hub2 queue length is %d, want 2", len(state2.Queue))
	}

	// Verify order is preserved
	if state2.Queue[0].ID != track1ID {
		t.Fatalf("hub2 queue[0] ID is %s, want %s", state2.Queue[0].ID, track1ID)
	}
	if state2.Queue[1].ID != track2ID {
		t.Fatalf("hub2 queue[1] ID is %s, want %s", state2.Queue[1].ID, track2ID)
	}

	// Verify now_playing persisted
	if state2.NowPlayingID != track2ID {
		t.Fatalf("hub2 NowPlayingID is %s, want %s", state2.NowPlayingID, track2ID)
	}

	// Verify version was incremented (at least 2: one for first add, one for now_playing set)
	if state2.Version < 2 {
		t.Fatalf("hub2 version is %d, want >= 2", state2.Version)
	}
}
