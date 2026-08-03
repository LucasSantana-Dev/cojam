// Package rebind tracks consumed anonymous identities (subs) for the
// guest-to-account upgrade (#172): a successful room.rebind burns the guest's
// anonymous sub so its proof token is single-use end to end. The
// connection-token endpoint refuses to reissue a consumed sub, which kills
// the indefinite-replay tail against zombie anonymous connections.
package rebind

import (
	"context"
	"fmt"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
)

// BurnList records consumed anonymous subs. Claim is atomic: the first
// caller to claim a sub wins and later claims report claimed=false, so two
// concurrent rebinds presenting the same proof cannot both commit.
type BurnList interface {
	// Claim atomically records sub as consumed. claimed is false when the sub
	// was already consumed (first claim wins).
	Claim(ctx context.Context, sub string) (claimed bool, err error)
	// Consumed reports whether sub was already consumed (read path for the
	// connection-token refresh gate).
	Consumed(ctx context.Context, sub string) (bool, error)
}

// Memory is an in-memory BurnList. Burns do not survive restart; in-memory
// deployments keep no room state across restarts either, so a replayed proof
// after a restart finds nothing left to claim.
type Memory struct {
	mu   sync.Mutex
	subs map[string]struct{}
}

// NewMemory creates an empty in-memory BurnList.
func NewMemory() *Memory {
	return &Memory{subs: make(map[string]struct{})}
}

// Claim records sub, reporting whether this call was the first claim.
func (m *Memory) Claim(ctx context.Context, sub string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.subs[sub]; ok {
		return false, nil
	}
	m.subs[sub] = struct{}{}
	return true, nil
}

// Consumed reports whether sub was claimed before.
func (m *Memory) Consumed(ctx context.Context, sub string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.subs[sub]
	return ok, nil
}

// Postgres is a BurnList backed by the rebound_subs table, so burns survive
// restarts (the restart-surviving option the #172 spec calls for).
type Postgres struct {
	pool *pgxpool.Pool
}

// NewPostgres creates a Postgres BurnList on the given pool.
func NewPostgres(pool *pgxpool.Pool) *Postgres {
	return &Postgres{pool: pool}
}

// Claim records sub, reporting whether this call was the first claim. The
// primary key makes the check-and-set atomic across concurrent rebinds.
func (p *Postgres) Claim(ctx context.Context, sub string) (bool, error) {
	tag, err := p.pool.Exec(ctx, `
		INSERT INTO rebound_subs (sub) VALUES ($1)
		ON CONFLICT (sub) DO NOTHING
	`, sub)
	if err != nil {
		return false, fmt.Errorf("failed to claim rebound sub: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// Consumed reports whether sub was claimed before.
func (p *Postgres) Consumed(ctx context.Context, sub string) (bool, error) {
	var exists bool
	err := p.pool.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM rebound_subs WHERE sub = $1)
	`, sub).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("failed to check rebound sub: %w", err)
	}
	return exists, nil
}

// Compile-time assertions that both implementations satisfy BurnList.
var (
	_ BurnList = (*Memory)(nil)
	_ BurnList = (*Postgres)(nil)
)
