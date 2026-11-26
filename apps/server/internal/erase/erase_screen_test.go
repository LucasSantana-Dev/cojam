package erase

import (
	"context"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/dbtest"
)

// Screen share (#310): trail rows name the broadcaster by sub and display
// name. Erasure removes both, unless a kept broadcast report about the person
// in that room still needs the session as evidence.
func TestRun_ScreenSessions(t *testing.T) {
	pool := dbtest.Isolated(t)
	seed(t, pool)
	ctx := context.Background()
	// s1: the person broadcast in room-a, no report: anonymized.
	// s2: the person broadcast in room-z and was reported there: kept.
	// s3: someone else's session: untouched.
	mustExec(t, pool, `INSERT INTO moderation_actions (id, room_id, action, actor_user_id, subject_id, detail) VALUES
		('s1', 'room-a', 'screen.stop', $1, $1, '{"name":"Ana","peakViewers":2}'),
		('s2', 'room-z', 'screen.start', $1, $1, '{"name":"Ana"}'),
		('s3', 'room-z', 'screen.stop', $2, $2, '{"name":"Bia"}')`, person, other)
	mustExec(t, pool, `INSERT INTO reports (id, room_id, kind, reporter_sub, subject_sub, reason) VALUES
		('rb', 'room-z', 'broadcast', $1, $2, 'transmissão')`, other, person)

	got, err := Run(ctx, pool, baseRequest(), true)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if got.ScreenSessionsAnonymized != 1 || got.ScreenSessionsRetained != 1 {
		t.Fatalf("screen sessions anonymized/retained = %d/%d, want 1/1", got.ScreenSessionsAnonymized, got.ScreenSessionsRetained)
	}
	var subject string
	var hasName, keepsPeak bool
	pool.QueryRow(ctx, `SELECT subject_id, detail ? 'name', detail ? 'peakViewers' FROM moderation_actions WHERE id = 's1'`).
		Scan(&subject, &hasName, &keepsPeak)
	if subject != "" || hasName || !keepsPeak {
		t.Fatalf("s1 subject=%q name=%t peak=%t, want anonymized with the session facts kept", subject, hasName, keepsPeak)
	}
	pool.QueryRow(ctx, `SELECT subject_id FROM moderation_actions WHERE id = 's2'`).Scan(&subject)
	if subject != person {
		t.Fatalf("s2 subject=%q, want kept as evidence for the broadcast report", subject)
	}
	pool.QueryRow(ctx, `SELECT subject_id, detail ? 'name' FROM moderation_actions WHERE id = 's3'`).Scan(&subject, &hasName)
	if subject != other || !hasName {
		t.Fatal("another person's session was touched")
	}
}
