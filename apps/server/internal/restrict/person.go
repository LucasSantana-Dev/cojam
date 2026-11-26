package restrict

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Block is one identity's operator state (person_blocks, #259). Closing a
// room stops the room; a block stops the person in every room.
type Block struct {
	// UserID is the connection identity: "sb:<uuid>" for an account, the
	// guest id otherwise.
	UserID  string
	Blocked bool
	// ReportID links the row to the case that caused it (optional).
	ReportID  string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// userIDRe matches the identities the server stamps on connections: a guest
// id (connauth.NewSub) or "sb:" plus a Supabase user uuid. The charset keeps
// operator input plain; anything else cannot name a connection.
var userIDRe = regexp.MustCompile(`^(sb:)?[A-Za-z0-9_-]{1,128}$`)

// ValidUserID reports whether id can be a connection identity.
func ValidUserID(id string) bool { return userIDRe.MatchString(id) }

// IsAccount reports whether id is an account identity, the only kind a person
// cannot replace by clearing their browser's storage.
func IsAccount(id string) bool { return strings.HasPrefix(id, "sb:") }

// GetBlock returns the identity's row; ok is false when the operator never
// acted on it.
func (p *Postgres) GetBlock(ctx context.Context, userID string) (b Block, ok bool, err error) {
	err = p.pool.QueryRow(ctx, `
		SELECT user_id, blocked, report_id, created_at, updated_at
		FROM person_blocks WHERE user_id = $1`, userID).
		Scan(&b.UserID, &b.Blocked, &b.ReportID, &b.CreatedAt, &b.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Block{UserID: userID}, false, nil
	}
	if err != nil {
		return Block{}, false, fmt.Errorf("failed to read person block: %w", err)
	}
	return b, true, nil
}

// PutBlock writes the identity's blocked flag and report id. created_at is
// kept from the first write; updated_at moves on every write.
func (p *Postgres) PutBlock(ctx context.Context, b Block) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO person_blocks (user_id, blocked, report_id)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE SET
			blocked = EXCLUDED.blocked,
			report_id = EXCLUDED.report_id,
			updated_at = now()`,
		b.UserID, b.Blocked, b.ReportID)
	if err != nil {
		return fmt.Errorf("failed to write person block: %w", err)
	}
	return nil
}

// ListBlocks returns every blocked identity, most recently changed first.
func (p *Postgres) ListBlocks(ctx context.Context) ([]Block, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT user_id, blocked, report_id, created_at, updated_at
		FROM person_blocks WHERE blocked
		ORDER BY updated_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("failed to list person blocks: %w", err)
	}
	defer rows.Close()
	var out []Block
	for rows.Next() {
		var b Block
		if err := rows.Scan(&b.UserID, &b.Blocked, &b.ReportID, &b.CreatedAt, &b.UpdatedAt); err != nil {
			return nil, fmt.Errorf("failed to read person block: %w", err)
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to list person blocks: %w", err)
	}
	return out, nil
}

// BlockedUsers returns the ids of every blocked identity.
func (p *Postgres) BlockedUsers(ctx context.Context) ([]string, error) {
	rows, err := p.pool.Query(ctx, `SELECT user_id FROM person_blocks WHERE blocked`)
	if err != nil {
		return nil, fmt.Errorf("failed to read blocked people: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("failed to read blocked people: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to read blocked people: %w", err)
	}
	return ids, nil
}

// ReportSubject is what `server person --report` needs from a report: who
// the server says it is about, and whether that agrees with what the
// reporter wrote.
type ReportSubject struct {
	RoomID string
	Kind   string
	// Sub, Name and Text come from the server (reports.subject_*); empty
	// when it could not resolve the subject.
	Sub  string
	Name string
	Text string
	// Content is the reporter's copy: the member's label or the chat line.
	Content string
}

// Consistent reports whether the reporter's copy names the same subject the
// server resolved. A member report's content is the label the client showed,
// which is the display name plus an optional de-duplication suffix; a
// message report's content is the line itself. A report the server could
// not describe is never consistent: there is nothing to check it against.
func (r ReportSubject) Consistent() bool {
	switch r.Kind {
	case "member":
		return r.Name != "" && strings.HasPrefix(r.Content, r.Name)
	case "message":
		return r.Text != "" && r.Content == r.Text
	}
	return false
}

// GetReportSubject reads a report for `server person --report`. ok is false
// when no such report exists.
func (p *Postgres) GetReportSubject(ctx context.Context, reportID string) (r ReportSubject, ok bool, err error) {
	err = p.pool.QueryRow(ctx, `
		SELECT room_id, kind, subject_sub, subject_name, subject_text, content
		FROM reports WHERE id = $1`, reportID).
		Scan(&r.RoomID, &r.Kind, &r.Sub, &r.Name, &r.Text, &r.Content)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReportSubject{}, false, nil
	}
	if err != nil {
		return ReportSubject{}, false, fmt.Errorf("failed to read report: %w", err)
	}
	return r, true, nil
}

// HoldRoom sets the legal hold on one room without touching its other
// flags, so it cannot overwrite a concurrent close or reopen. reportID is
// recorded only when the row has none yet.
func (p *Postgres) HoldRoom(ctx context.Context, roomID, reportID string) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO room_restrictions (room_id, legal_hold, report_id)
		VALUES ($1, true, $2)
		ON CONFLICT (room_id) DO UPDATE SET
			legal_hold = true,
			report_id = CASE WHEN room_restrictions.report_id = '' THEN EXCLUDED.report_id
			                 ELSE room_restrictions.report_id END,
			updated_at = CASE WHEN room_restrictions.legal_hold THEN room_restrictions.updated_at
			                  ELSE now() END`,
		roomID, reportID)
	if err != nil {
		return fmt.Errorf("failed to hold room: %w", err)
	}
	return nil
}
