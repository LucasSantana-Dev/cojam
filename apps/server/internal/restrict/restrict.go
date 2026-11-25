// Package restrict holds operator restrictions on a room (#259): closing it
// (members are disconnected and every rejoin is refused) and a legal hold
// (its reports and moderation actions survive the retention purge and
// `server erase`). The operator writes rows with the `server room` command;
// the running server polls the closed set (Watch) and the purge and erase
// queries read the hold directly (HeldSQL).
package restrict

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Restriction is one room's operator state.
type Restriction struct {
	RoomID    string
	Closed    bool
	LegalHold bool
	// ReportID links the row to the case that caused it (optional).
	ReportID  string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// HeldSQL returns a SQL predicate that is true when the row aliased alias
// (which has a room_id column) belongs to a room under legal hold. alias is a
// fixed identifier from the caller, never user input.
func HeldSQL(alias string) string {
	return `EXISTS (SELECT 1 FROM room_restrictions rr WHERE rr.room_id = ` + alias +
		`.room_id AND rr.legal_hold)`
}

// Postgres reads and writes room_restrictions.
type Postgres struct {
	pool *pgxpool.Pool
}

// NewPostgres wraps a pool whose schema has migration 0009.
func NewPostgres(pool *pgxpool.Pool) *Postgres { return &Postgres{pool: pool} }

// Get returns the room's row; ok is false when the operator never acted on it.
func (p *Postgres) Get(ctx context.Context, roomID string) (r Restriction, ok bool, err error) {
	err = p.pool.QueryRow(ctx, `
		SELECT room_id, closed, legal_hold, report_id, created_at, updated_at
		FROM room_restrictions WHERE room_id = $1`, roomID).
		Scan(&r.RoomID, &r.Closed, &r.LegalHold, &r.ReportID, &r.CreatedAt, &r.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Restriction{RoomID: roomID}, false, nil
	}
	if err != nil {
		return Restriction{}, false, fmt.Errorf("failed to read room restriction: %w", err)
	}
	return r, true, nil
}

// Put writes the room's closed and hold flags and report id. created_at is
// kept from the first write; updated_at moves on every write.
func (p *Postgres) Put(ctx context.Context, r Restriction) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO room_restrictions (room_id, closed, legal_hold, report_id)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (room_id) DO UPDATE SET
			closed = EXCLUDED.closed,
			legal_hold = EXCLUDED.legal_hold,
			report_id = EXCLUDED.report_id,
			updated_at = now()`,
		r.RoomID, r.Closed, r.LegalHold, r.ReportID)
	if err != nil {
		return fmt.Errorf("failed to write room restriction: %w", err)
	}
	return nil
}

// List returns every row with a flag set, most recently changed first.
func (p *Postgres) List(ctx context.Context) ([]Restriction, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT room_id, closed, legal_hold, report_id, created_at, updated_at
		FROM room_restrictions WHERE closed OR legal_hold
		ORDER BY updated_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("failed to list room restrictions: %w", err)
	}
	defer rows.Close()
	var out []Restriction
	for rows.Next() {
		var r Restriction
		if err := rows.Scan(&r.RoomID, &r.Closed, &r.LegalHold, &r.ReportID, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to read room restriction: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to list room restrictions: %w", err)
	}
	return out, nil
}

// ClosedRooms returns the ids of every closed room.
func (p *Postgres) ClosedRooms(ctx context.Context) ([]string, error) {
	rows, err := p.pool.Query(ctx, `SELECT room_id FROM room_restrictions WHERE closed`)
	if err != nil {
		return nil, fmt.Errorf("failed to read closed rooms: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("failed to read closed rooms: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to read closed rooms: %w", err)
	}
	return ids, nil
}
