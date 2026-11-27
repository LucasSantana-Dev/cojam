package flags

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
)

// Store reads and writes overrides. Postgres in production; tests use fakes.
type Store interface {
	List(ctx context.Context) (map[string]Override, error)
	Set(ctx context.Context, name string, next Value, actor, note string) (before Value, err error)
	Changes(ctx context.Context, limit int) ([]Change, error)
}

// Postgres is the Store over migration 0012.
type Postgres struct {
	pool *pgxpool.Pool
}

// NewPostgres wraps a pool whose schema has migration 0012.
func NewPostgres(pool *pgxpool.Pool) *Postgres { return &Postgres{pool: pool} }

// List returns every stored override, including rows cleared back to the
// environment (IsZero).
func (p *Postgres) List(ctx context.Context) (map[string]Override, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT name, enabled, room_allowlist IS NULL, coalesce(room_allowlist, '{}'), updated_at, updated_by
		FROM feature_flags`)
	if err != nil {
		return nil, fmt.Errorf("failed to read feature flags: %w", err)
	}
	defer rows.Close()
	out := make(map[string]Override)
	for rows.Next() {
		var name string
		var o Override
		var roomsNull bool
		var rooms []string
		if err := rows.Scan(&name, &o.Enabled, &roomsNull, &rooms, &o.UpdatedAt, &o.UpdatedBy); err != nil {
			return nil, fmt.Errorf("failed to read feature flags: %w", err)
		}
		if !roomsNull {
			if rooms == nil {
				rooms = []string{}
			}
			o.Rooms = &rooms
		}
		out[name] = o
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to read feature flags: %w", err)
	}
	return out, nil
}

// Set writes the flag's override and its audit row in one transaction and
// returns what the override was before. The row is locked first, so two
// writers record a consistent before/after chain.
func (p *Postgres) Set(ctx context.Context, name string, next Value, actor, note string) (Value, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return Value{}, fmt.Errorf("failed to write feature flag: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // a no-op after Commit

	var before Value
	var roomsNull bool
	var rooms []string
	err = tx.QueryRow(ctx, `
		SELECT enabled, room_allowlist IS NULL, coalesce(room_allowlist, '{}')
		FROM feature_flags WHERE name = $1 FOR UPDATE`, name).Scan(&before.Enabled, &roomsNull, &rooms)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		return Value{}, fmt.Errorf("failed to read feature flag: %w", err)
	case !roomsNull:
		if rooms == nil {
			rooms = []string{}
		}
		before.Rooms = &rooms
	}

	var nextRooms any // nil -> SQL NULL
	if next.Rooms != nil {
		nextRooms = *next.Rooms
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO feature_flags (name, enabled, room_allowlist, updated_by)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (name) DO UPDATE SET
			enabled = EXCLUDED.enabled,
			room_allowlist = EXCLUDED.room_allowlist,
			updated_by = EXCLUDED.updated_by,
			updated_at = now()`,
		name, next.Enabled, nextRooms, actor); err != nil {
		return Value{}, fmt.Errorf("failed to write feature flag: %w", err)
	}
	beforeJSON, _ := json.Marshal(before)
	afterJSON, _ := json.Marshal(next)
	if _, err := tx.Exec(ctx, `
		INSERT INTO feature_flag_changes (name, before, after, actor, note)
		VALUES ($1, $2, $3, $4, $5)`,
		name, beforeJSON, afterJSON, actor, note); err != nil {
		return Value{}, fmt.Errorf("failed to record feature flag change: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Value{}, fmt.Errorf("failed to write feature flag: %w", err)
	}
	return before, nil
}

// Changes returns the most recent changes, newest first.
func (p *Postgres) Changes(ctx context.Context, limit int) ([]Change, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, name, before, after, actor, note, created_at
		FROM feature_flag_changes ORDER BY created_at DESC, id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to read feature flag changes: %w", err)
	}
	defer rows.Close()
	var out []Change
	for rows.Next() {
		var c Change
		var before, after []byte
		if err := rows.Scan(&c.ID, &c.Name, &before, &after, &c.Actor, &c.Note, &c.CreatedAt); err != nil {
			return nil, fmt.Errorf("failed to read feature flag changes: %w", err)
		}
		if err := json.Unmarshal(before, &c.Before); err != nil {
			return nil, fmt.Errorf("failed to decode feature flag change: %w", err)
		}
		if err := json.Unmarshal(after, &c.After); err != nil {
			return nil, fmt.Errorf("failed to decode feature flag change: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Runtime keeps the effective flags current: it reads the store, resolves
// against the environment and hands the result to apply (the hub). A failed
// read keeps the last applied state, so a database blip never flips a flag.
// With a nil store it serves the environment alone.
type Runtime struct {
	getenv func(string) string
	store  Store
	apply  func([]Effective)
	logger *slog.Logger

	loadMu    sync.Mutex // serializes Load: the poll and an admin write
	mu        sync.RWMutex
	current   []Effective
	overrides map[string]Override
}

// NewRuntime resolves the environment alone and applies it once, so the
// state is valid before the first Load.
func NewRuntime(getenv func(string) string, store Store, apply func([]Effective), logger *slog.Logger) *Runtime {
	r := &Runtime{getenv: getenv, store: store, apply: apply, logger: logger}
	r.set(map[string]Override{})
	return r
}

// HasStore reports whether overrides can be written.
func (r *Runtime) HasStore() bool { return r.store != nil }

// Store returns the backing store (nil without a database).
func (r *Runtime) Store() Store { return r.store }

// Current returns the flags in force.
func (r *Runtime) Current() []Effective {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.current
}

// Load reads the store and applies the result. On error the last state
// stays in force.
func (r *Runtime) Load(ctx context.Context) error {
	if r.store == nil {
		return nil
	}
	r.loadMu.Lock()
	defer r.loadMu.Unlock()
	overrides, err := r.store.List(ctx)
	if err != nil {
		return err
	}
	r.set(overrides)
	return nil
}

func (r *Runtime) set(overrides map[string]Override) {
	next := Resolve(r.getenv, overrides)
	r.mu.Lock()
	prev := r.current
	r.current, r.overrides = next, overrides
	r.mu.Unlock()
	if r.logger != nil {
		for _, e := range next {
			if p, ok := Find(prev, e.Name); ok && p.Enabled == e.Enabled && sameRooms(p.Rooms, e.Rooms) {
				continue
			}
			r.logger.Info("feature_flag_applied", "flag", e.Name, "enabled", e.Enabled,
				"source", e.Source, "room_allowlist", len(e.Rooms), "blocked", e.Blocked != "")
		}
	}
	if r.apply != nil {
		r.apply(next)
	}
}

func sameRooms(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Start loads every interval until the returned stop is called; stop waits
// for the loop to exit so shutdown can close the pool right after.
func (r *Runtime) Start(interval time.Duration) (stop func()) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	obs.SafeGo("feature_flags", func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				readCtx, cancelRead := context.WithTimeout(ctx, 10*time.Second)
				err := r.Load(readCtx)
				cancelRead()
				if err != nil && r.logger != nil && ctx.Err() == nil {
					r.logger.Error("feature_flags_poll_failed", "err", err.Error())
				}
			}
		}
	})
	return func() {
		cancel()
		<-done
	}
}
