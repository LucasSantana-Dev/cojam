package store

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// ErrNotFound is returned by Load when a room does not exist in the store.
var ErrNotFound = errors.New("store: room not found")

// ErrNilProtected is returned by DeleteIdleRooms when the protected set is
// nil. The membership gate is the only thing standing between the sweep and
// a live room's row (#169), so the caller must state it explicitly; an
// allocated empty set is valid and means "no rooms currently have members".
var ErrNilProtected = errors.New("store: DeleteIdleRooms requires an explicit protected set")

// Store persists and retrieves room state.
type Store interface {
	// Load retrieves a room's state by ID. Returns (nil, ErrNotFound) if the room
	// does not exist. The returned state is a deep copy so the caller cannot mutate
	// what is stored.
	Load(ctx context.Context, roomID string) (*queue.RoomState, error)

	// Save persists a room's state. The store makes a deep copy so the caller's
	// subsequent mutations do not affect what is stored.
	Save(ctx context.Context, state *queue.RoomState) error

	// DeleteIdleRooms removes every room row whose updated_at is older than
	// cutoff, skipping the room ids in protected, and returns how many rows
	// it removed (#169). A nil protected set is an error (ErrNilProtected):
	// the caller must state explicitly which live rooms to protect.
	DeleteIdleRooms(ctx context.Context, cutoff time.Time, protected map[string]struct{}) (int64, error)
}

// Memory is an in-memory Store implementation using a RWMutex-guarded map.
// All Load and Save operations deep-copy the state via marshal/unmarshal
// to ensure isolation: mutating the struct returned by Load or passed to Save
// does not affect what a subsequent Load returns.
type Memory struct {
	mu    sync.RWMutex
	rooms map[string]*queue.RoomState
}

// NewMemory creates a new in-memory store.
func NewMemory() *Memory {
	return &Memory{
		rooms: make(map[string]*queue.RoomState),
	}
}

// Load retrieves a room by ID, returning a deep copy (via marshal/unmarshal).
// Returns (nil, ErrNotFound) if the room does not exist.
func (m *Memory) Load(ctx context.Context, roomID string) (*queue.RoomState, error) {
	m.mu.RLock()
	stored, exists := m.rooms[roomID]
	m.mu.RUnlock()

	if !exists {
		return nil, ErrNotFound
	}

	// Deep copy via marshal/unmarshal to prevent caller mutation
	data, err := json.Marshal(stored)
	if err != nil {
		return nil, err
	}

	var copied queue.RoomState
	if err := json.Unmarshal(data, &copied); err != nil {
		return nil, err
	}

	return &copied, nil
}

// Save persists a room's state, making a deep copy (via marshal/unmarshal)
// so caller's subsequent mutations do not affect what is stored.
func (m *Memory) Save(ctx context.Context, state *queue.RoomState) error {
	// Deep copy via marshal/unmarshal
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}

	var copied queue.RoomState
	if err := json.Unmarshal(data, &copied); err != nil {
		return err
	}

	m.mu.Lock()
	m.rooms[copied.RoomID] = &copied
	m.mu.Unlock()

	return nil
}

// DeleteIdleRooms is a no-op for the in-memory store: there is nothing to
// reclaim, and the hub's in-memory evictor already handles residency. It
// still enforces the explicit-protected-set contract.
func (m *Memory) DeleteIdleRooms(ctx context.Context, cutoff time.Time, protected map[string]struct{}) (int64, error) {
	if protected == nil {
		return 0, ErrNilProtected
	}
	return 0, nil
}
