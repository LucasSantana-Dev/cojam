package events

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Postgres inserts and purges product_events.
type Postgres struct{ pool *pgxpool.Pool }

// NewPostgres wraps a pool.
func NewPostgres(pool *pgxpool.Pool) *Postgres { return &Postgres{pool: pool} }

// InsertEvents writes rows in one multi-row statement (unnest keeps the
// parameter count constant). Empty hashes become NULL.
func (p *Postgres) InsertEvents(ctx context.Context, rows []Row) error {
	if len(rows) == 0 {
		return nil
	}
	ats := make([]time.Time, len(rows))
	names := make([]string, len(rows))
	rooms := make([]string, len(rows))
	actors := make([]string, len(rows))
	props := make([]string, len(rows))
	for i, r := range rows {
		ats[i], names[i], rooms[i], actors[i], props[i] = r.At, r.Name, r.RoomHash, r.ActorHash, string(r.Props)
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO product_events (at, name, room_hash, actor_hash, props)
		SELECT at, name, NULLIF(room_hash, ''), NULLIF(actor_hash, ''), props::jsonb
		FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[])
		     AS t(at, name, room_hash, actor_hash, props)
	`, ats, names, rooms, actors, props)
	if err != nil {
		return fmt.Errorf("insert product_events: %w", err)
	}
	return nil
}

// PurgeBefore deletes events older than cutoff, oldest first, at most limit
// per call, so a large backlog never holds a long lock. It satisfies
// report.Purger and uses product_events_at_idx.
func (p *Postgres) PurgeBefore(ctx context.Context, cutoff time.Time, limit int) (int64, error) {
	tag, err := p.pool.Exec(ctx, PurgeSQL, cutoff, limit)
	if err != nil {
		return 0, fmt.Errorf("failed to purge product_events: %w", err)
	}
	return tag.RowsAffected(), nil
}

// PurgeSQL is the retention statement, exported so a test can pin it.
const PurgeSQL = `
		DELETE FROM product_events WHERE id IN (
			SELECT id FROM product_events WHERE at < $1 ORDER BY at LIMIT $2
		)
	`
