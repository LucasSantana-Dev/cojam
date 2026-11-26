package report

import (
	"context"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/dbtest"
)

// Screen share (#310): a broadcast report filed after the share ended
// resolves its subject from the newest screen session row in the trail.
func TestMemoryAudit_LatestBroadcast(t *testing.T) {
	ctx := context.Background()
	m := NewMemoryAudit()
	now := time.Now().UTC()
	_ = m.Record(ctx, Action{ID: "1", RoomID: "R", Action: "screen.start", SubjectID: "old", CreatedAt: now.Add(-8 * 24 * time.Hour)})
	_ = m.Record(ctx, Action{ID: "2", RoomID: "R", Action: "room.kick", SubjectID: "c1", CreatedAt: now.Add(-time.Hour)})
	_ = m.Record(ctx, Action{ID: "3", RoomID: "other", Action: "screen.stop", SubjectID: "x", CreatedAt: now})

	since := now.Add(-BroadcastLookbackDays * 24 * time.Hour)
	if _, ok, _ := m.LatestBroadcast(ctx, "R", since); ok {
		t.Fatal("a session older than the lookback or a non-screen row must not match")
	}
	_ = m.Record(ctx, Action{ID: "4", RoomID: "R", Action: "screen.stop", SubjectID: "sub-b", Detail: map[string]any{"name": "Bia"}, CreatedAt: now.Add(-6 * 24 * time.Hour)})
	a, ok, err := m.LatestBroadcast(ctx, "R", since)
	if err != nil || !ok || a.SubjectID != "sub-b" || a.Detail["name"] != "Bia" {
		t.Fatalf("LatestBroadcast = %+v, %v, %v", a, ok, err)
	}
}

// The migration widens both CHECKs (dropping the old ones by name) and adds
// detail; the Postgres lookup reads it back.
func TestPostgresAudit_ScreenRowsAndBroadcastReports(t *testing.T) {
	pool := dbtest.Isolated(t)
	ctx := context.Background()
	audit := NewPostgresAudit(pool)
	reports := NewPostgres(pool)
	now := time.Now().UTC()

	for i, action := range []string{"screen.start", "screen.stop", "screen.host_stop", "screen.refuse"} {
		if err := audit.Record(ctx, Action{
			ID: string(rune('a' + i)), RoomID: "ABCDEF123456", Action: action, ActorUserID: "sub-host",
			SubjectID: "sub-b", Detail: map[string]any{"name": "Bia", "peakViewers": 2}, CreatedAt: now.Add(time.Duration(i) * time.Second),
		}); err != nil {
			t.Fatalf("record %s: %v", action, err)
		}
	}
	// The older actions still insert with an empty detail.
	if err := audit.Record(ctx, Action{ID: "k", RoomID: "ABCDEF123456", Action: "room.kick", CreatedAt: now}); err != nil {
		t.Fatalf("record room.kick: %v", err)
	}
	if err := reports.Create(ctx, Report{ID: "r1", RoomID: "ABCDEF123456", Kind: KindBroadcast, CreatedAt: now}); err != nil {
		t.Fatalf("broadcast report: %v", err)
	}

	a, ok, err := audit.LatestBroadcast(ctx, "ABCDEF123456", now.Add(-time.Hour))
	if err != nil || !ok {
		t.Fatalf("LatestBroadcast: %v, %v", ok, err)
	}
	// screen.refuse is not a session row: the newest session row is host_stop.
	if a.Action != "screen.host_stop" || a.SubjectID != "sub-b" || a.Detail["name"] != "Bia" {
		t.Fatalf("LatestBroadcast = %+v", a)
	}
	if _, ok, _ := audit.LatestBroadcast(ctx, "ZZZZZZZZZZZZ", now.Add(-time.Hour)); ok {
		t.Fatal("another room must not match")
	}
}
