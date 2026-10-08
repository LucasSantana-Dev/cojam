package hub

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/dbtest"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

// TestHubPersistenceAcrossRestart proves room state survives a hub restart
// by persisting through PostgreSQL. Skips if TEST_DATABASE_URL is unset.
func TestHubPersistenceAcrossRestart(t *testing.T) {
	// A real database, on a private schema dropped when the test ends.
	pool := dbtest.Isolated(t)

	roomID := "test_persist"

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
	// Setting track 2 retires track 1 (the outgoing track) to History.
	if len(state1.Queue) != 1 || len(state1.History) != 1 || state1.History[0].ID != track1ID {
		t.Fatalf("hub1 queue=%d history=%d, want 1 and 1 (track1)", len(state1.Queue), len(state1.History))
	}
	if state1.NowPlayingID != track2ID {
		t.Fatalf("hub1 NowPlayingID is %s, want %s", state1.NowPlayingID, track2ID)
	}

	// Create second hub (fresh instance) with postgres store on same database
	pgStore2 := store.NewPostgres(pool)
	hub2 := NewHub(nil).WithStore(pgStore2)

	// Load the room in hub2 (read-through load from store)
	room2 := mustRoom(t, hub2, roomID)
	if room2 == nil || room2.State == nil {
		t.Fatalf("hub2 failed to load room from store")
	}

	state2 := room2.State

	// Verify persistence: same queue length and content
	if len(state2.Queue) != 1 || state2.Queue[0].ID != track2ID {
		t.Fatalf("hub2 queue = %+v, want only track2", state2.Queue)
	}
	if len(state2.History) != 1 || state2.History[0].ID != track1ID {
		t.Fatalf("hub2 history = %+v, want track1", state2.History)
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

// TestPromotedHostSurvivesPersistence proves a host promoted by
// PromoteOnDisconnect (#166) is written through to Postgres and reloads.
// Skips if TEST_DATABASE_URL is unset.
func TestPromotedHostSurvivesPersistence(t *testing.T) {
	pool := dbtest.Isolated(t)

	roomID := "test_handoff_persist"

	hub1 := NewHub(nil).WithStore(store.NewPostgres(pool))

	// Host plus two authenticated members; u-a is the longest-present.
	room := mustRoom(t, hub1, roomID)
	room.mu.Lock()
	room.State.HostUserID = "u-host"
	room.mu.Unlock()
	hub1.RecordClientUserID("c-host", "u-host")
	hub1.RecordClientUserID("c-a", "u-a")
	hub1.RecordClientUserID("c-b", "u-b")
	hub1.Join("c-host", roomID)
	hub1.Join("c-a", roomID)
	hub1.Join("c-b", roomID)
	hub1.memberMu.Lock()
	hub1.memberJoinTimes[roomID] = map[string]int64{"u-a": 100, "u-b": 200}
	hub1.memberMu.Unlock()

	hub1.PromoteOnDisconnect("c-host")

	// A fresh hub on the same database loads the promoted host.
	hub2 := NewHub(nil).WithStore(store.NewPostgres(pool))
	room2 := mustRoom(t, hub2, roomID)
	if room2.State.HostUserID != "u-a" {
		t.Fatalf("persisted HostUserID = %q, want u-a", room2.State.HostUserID)
	}
}
