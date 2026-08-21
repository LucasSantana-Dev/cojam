// Package report records member reports about a room, a member, or a chat
// message (#259). Design: docs/specs/259-eca-minor-safety.md.
//
// A report copies the content it concerns. Chat is ephemeral and dies with the
// room, so a report holding only a pointer would be empty by the time anyone
// read it.
package report

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Kind is what a report is about.
type Kind string

const (
	KindMessage Kind = "message"
	KindMember  Kind = "member"
	KindRoom    Kind = "room"
)

// ErrInvalidKind reports an unrecognised kind.
var ErrInvalidKind = errors.New("unknown report kind")

// Valid reports whether k is one of the recognised kinds. Callers validate
// before storing so an arbitrary string never reaches the database.
func (k Kind) Valid() bool {
	return k == KindMessage || k == KindMember || k == KindRoom
}

// Report is one member's record that something needs attention.
type Report struct {
	ID     string
	RoomID string
	Kind   Kind
	// ReporterSub is the connauth identity of whoever filed it, empty when room
	// auth is off. Reporting stays open to guests: requiring an account would
	// exclude most of the people it exists to protect.
	ReporterSub string
	// SubjectID is the reported message or member id; empty for a room report.
	SubjectID string
	// Content is a copy of what was reported, truncated. It exists because the
	// original is usually gone by the time this is read.
	Content   string
	Reason    string
	CreatedAt time.Time
}

// Store persists reports.
type Store interface {
	Create(ctx context.Context, r Report) error
	// Recent returns the newest reports, for the operator to review.
	Recent(ctx context.Context, limit int) ([]Report, error)
}

// Memory is an in-memory Store for local dev and databaseless deployments.
// Reports do not survive restart, which is a real limitation for this
// particular record and the reason Postgres is the intended deployment.
type Memory struct {
	mu      sync.Mutex
	reports []Report
}

// NewMemory creates an empty in-memory Store.
func NewMemory() *Memory { return &Memory{} }

func (m *Memory) Create(_ context.Context, r Report) error {
	if !r.Kind.Valid() {
		return ErrInvalidKind
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reports = append(m.reports, r)
	return nil
}

func (m *Memory) Recent(_ context.Context, limit int) ([]Report, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	out := make([]Report, 0, limit)
	for i := len(m.reports) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, m.reports[i])
	}
	return out, nil
}

// Postgres is a Store backed by the reports table.
type Postgres struct {
	pool *pgxpool.Pool
}

// NewPostgres creates a Postgres Store on the given pool.
func NewPostgres(pool *pgxpool.Pool) *Postgres { return &Postgres{pool: pool} }

func (p *Postgres) Create(ctx context.Context, r Report) error {
	if !r.Kind.Valid() {
		return ErrInvalidKind
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO reports (id, room_id, kind, reporter_sub, subject_id, content, reason, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`, r.ID, r.RoomID, string(r.Kind), r.ReporterSub, r.SubjectID, r.Content, r.Reason, r.CreatedAt)
	if err != nil {
		return fmt.Errorf("failed to store report: %w", err)
	}
	return nil
}

func (p *Postgres) Recent(ctx context.Context, limit int) ([]Report, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, room_id, kind, reporter_sub, subject_id, content, reason, created_at
		FROM reports ORDER BY created_at DESC LIMIT $1
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to load reports: %w", err)
	}
	defer rows.Close()

	var out []Report
	for rows.Next() {
		var r Report
		var kind string
		if err := rows.Scan(&r.ID, &r.RoomID, &kind, &r.ReporterSub, &r.SubjectID,
			&r.Content, &r.Reason, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan report: %w", err)
		}
		r.Kind = Kind(kind)
		out = append(out, r)
	}
	return out, rows.Err()
}

// Action is a completed moderation action. chat.delete and room.kick left no
// durable record before this (#259): stdout is not an audit trail, since it is
// unqueryable and gone when the container recycles.
type Action struct {
	ID          string
	RoomID      string
	Action      string // "chat.delete" | "room.kick"
	ActorUserID string // the host who acted
	SubjectID   string // message id or client id
	CreatedAt   time.Time
}

// AuditStore persists moderation actions.
type AuditStore interface {
	Record(ctx context.Context, a Action) error
	RecentActions(ctx context.Context, limit int) ([]Action, error)
}

// MemoryAudit is an in-memory AuditStore.
type MemoryAudit struct {
	mu      sync.Mutex
	actions []Action
}

func NewMemoryAudit() *MemoryAudit { return &MemoryAudit{} }

func (m *MemoryAudit) Record(_ context.Context, a Action) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.actions = append(m.actions, a)
	return nil
}

func (m *MemoryAudit) RecentActions(_ context.Context, limit int) ([]Action, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	out := make([]Action, 0, limit)
	for i := len(m.actions) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, m.actions[i])
	}
	return out, nil
}

// PostgresAudit is an AuditStore backed by the moderation_actions table.
type PostgresAudit struct {
	pool *pgxpool.Pool
}

func NewPostgresAudit(pool *pgxpool.Pool) *PostgresAudit { return &PostgresAudit{pool: pool} }

func (p *PostgresAudit) Record(ctx context.Context, a Action) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO moderation_actions (id, room_id, action, actor_user_id, subject_id, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, a.ID, a.RoomID, a.Action, a.ActorUserID, a.SubjectID, a.CreatedAt)
	if err != nil {
		return fmt.Errorf("failed to record moderation action: %w", err)
	}
	return nil
}

func (p *PostgresAudit) RecentActions(ctx context.Context, limit int) ([]Action, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, room_id, action, actor_user_id, subject_id, created_at
		FROM moderation_actions ORDER BY created_at DESC LIMIT $1
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to load moderation actions: %w", err)
	}
	defer rows.Close()

	var out []Action
	for rows.Next() {
		var a Action
		if err := rows.Scan(&a.ID, &a.RoomID, &a.Action, &a.ActorUserID, &a.SubjectID, &a.CreatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan moderation action: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
