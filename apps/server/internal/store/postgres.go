package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Postgres is a PostgreSQL implementation of the Store interface.
// All Load and Save operations deep-copy the state via marshal/unmarshal
// to ensure isolation: mutating the struct returned by Load or passed to Save
// does not affect what a subsequent Load returns.
type Postgres struct {
	pool *pgxpool.Pool
}

// NewPostgres creates a new PostgreSQL store backed by the given connection pool.
func NewPostgres(pool *pgxpool.Pool) *Postgres {
	return &Postgres{
		pool: pool,
	}
}

// Load retrieves a room by ID, returning a deep copy (via marshal/unmarshal).
// Returns (nil, ErrNotFound) if the room does not exist.
func (p *Postgres) Load(ctx context.Context, roomID string) (*queue.RoomState, error) {
	var stateJSON []byte
	err := p.pool.QueryRow(ctx, "SELECT state FROM rooms WHERE room_id = $1", roomID).Scan(&stateJSON)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("failed to load room %s: %w", roomID, err)
	}

	// Deep copy via unmarshal to prevent caller mutation
	var state queue.RoomState
	if err := json.Unmarshal(stateJSON, &state); err != nil {
		return nil, fmt.Errorf("failed to unmarshal room state for %s: %w", roomID, err)
	}

	return &state, nil
}

// Save persists a room's state using a version-guarded upsert.
// The upsert only updates if the new version is strictly greater than the stored version,
// ensuring stale writes are rejected. A deep copy is made before storage to ensure
// the caller's subsequent mutations do not affect what is stored.
func (p *Postgres) Save(ctx context.Context, state *queue.RoomState) error {
	// Deep copy via marshal/unmarshal to prevent caller mutation
	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("failed to marshal room state for %s: %w", state.RoomID, err)
	}

	var copied queue.RoomState
	if err := json.Unmarshal(data, &copied); err != nil {
		return fmt.Errorf("failed to unmarshal copied room state for %s: %w", state.RoomID, err)
	}

	stateJSON, err := json.Marshal(&copied)
	if err != nil {
		return fmt.Errorf("failed to marshal copied room state for %s: %w", state.RoomID, err)
	}

	// Version-guarded upsert: apply only when the incoming version is newer.
	// A stale write (incoming version <= stored) affects zero rows and returns
	// nil ON PURPOSE, not as an error. This is the intended optimistic-concurrency
	// semantics (RFC-0001): the hub persists after releasing the room lock, so
	// out-of-order saves from concurrent mutations are expected, and the older one
	// must be dropped silently rather than surfaced as a failure. Correctness does
	// not depend on which save wins; the row always converges to the highest
	// version, so no data is lost. If a caller ever needs to observe a rejection,
	// the command tag's RowsAffected is the seam to expose it.
	_, err = p.pool.Exec(ctx, `
		INSERT INTO rooms (room_id, state, version, updated_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (room_id) DO UPDATE
		SET state = excluded.state, version = excluded.version, updated_at = now()
		WHERE excluded.version > rooms.version
	`, copied.RoomID, stateJSON, copied.Version)

	if err != nil {
		return fmt.Errorf("failed to save room %s: %w", state.RoomID, err)
	}

	return nil
}

// Compile-time assertion that *Postgres satisfies the Store interface
var _ Store = (*Postgres)(nil)
