package restrict

import (
	"context"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/dbtest"
)

type fakeBlocked struct{ ids []string }

func (f fakeBlocked) BlockedUsers(context.Context) ([]string, error) { return f.ids, nil }

func TestValidUserID(t *testing.T) {
	for id, want := range map[string]bool{
		"3f2b9c1e-6a7d-4e1f-9b0a-2c4d6e8f0a1b":    true,
		"sb:3f2b9c1e-6a7d-4e1f-9b0a-2c4d6e8f0a1b": true,
		"":            false,
		"sb:":         false,
		"has space":   false,
		"sb:a\nb":     false,
		"client:abc":  false,
		"<@everyone>": false,
	} {
		if got := ValidUserID(id); got != want {
			t.Errorf("ValidUserID(%q) = %v, want %v", id, got, want)
		}
	}
	if !IsAccount("sb:abc") || IsAccount("abc") {
		t.Fatal("IsAccount must be true only for sb: identities")
	}
}

// WatchBlocked hands the blocked set to apply, like Watch does for rooms.
func TestWatchBlocked_AppliesTheSet(t *testing.T) {
	got := make(chan []string, 4)
	stop := WatchBlocked(fakeBlocked{ids: []string{"sb:abc"}}, time.Hour, func(ids []string) { got <- ids }, nil)
	defer stop()
	select {
	case ids := <-got:
		if len(ids) != 1 || ids[0] != "sb:abc" {
			t.Fatalf("applied %v, want [sb:abc]", ids)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("WatchBlocked never applied the first read")
	}
}

// PutBlock upserts and keeps created_at; ListBlocks and BlockedUsers see only
// blocked rows; ReportSubject reads the resolved subject of a report. Skips
// if TEST_DATABASE_URL is not set.
func TestPostgres_PersonBlocks(t *testing.T) {
	pool := dbtest.Isolated(t)
	ctx := context.Background()
	s := NewPostgres(pool)

	if _, ok, err := s.GetBlock(ctx, "sb:abc"); err != nil || ok {
		t.Fatalf("GetBlock of an untouched identity = ok %v, err %v; want false, nil", ok, err)
	}
	if err := s.PutBlock(ctx, Block{UserID: "sb:abc", Blocked: true, ReportID: "rep-1"}); err != nil {
		t.Fatalf("PutBlock: %v", err)
	}
	if err := s.PutBlock(ctx, Block{UserID: "guest-1", Blocked: true}); err != nil {
		t.Fatalf("PutBlock: %v", err)
	}
	first, ok, err := s.GetBlock(ctx, "sb:abc")
	if err != nil || !ok || !first.Blocked || first.ReportID != "rep-1" {
		t.Fatalf("GetBlock = %+v, %v, %v", first, ok, err)
	}
	ids, err := s.BlockedUsers(ctx)
	if err != nil || len(ids) != 2 {
		t.Fatalf("BlockedUsers = %v, %v; want two", ids, err)
	}

	first.Blocked = false
	if err := s.PutBlock(ctx, first); err != nil {
		t.Fatalf("unblock: %v", err)
	}
	again, _, _ := s.GetBlock(ctx, "sb:abc")
	if again.Blocked || again.ReportID != "rep-1" || !again.CreatedAt.Equal(first.CreatedAt) {
		t.Fatalf("after unblock = %+v; want unblocked, same report and created_at", again)
	}
	list, err := s.ListBlocks(ctx)
	if err != nil || len(list) != 1 || list[0].UserID != "guest-1" {
		t.Fatalf("ListBlocks = %+v, %v; want only guest-1", list, err)
	}

	if _, ok, err := s.GetReportSubject(ctx, "missing"); err != nil || ok {
		t.Fatalf("GetReportSubject(missing) = ok %v, err %v; want false, nil", ok, err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO reports (id, room_id, kind, subject_id, subject_sub, subject_name, content)
		VALUES ('rep-2', 'ROOM1', 'member', 'client-9', 'sb:abc', 'Ana', 'Ana 2')`); err != nil {
		t.Fatalf("seed report: %v", err)
	}
	r, ok, err := s.GetReportSubject(ctx, "rep-2")
	if err != nil || !ok || r.RoomID != "ROOM1" || r.Sub != "sb:abc" || !r.Consistent() {
		t.Fatalf("GetReportSubject = %+v, %v, %v", r, ok, err)
	}

	// HoldRoom leaves a concurrent close alone and keeps the first case link.
	if err := s.Put(ctx, Restriction{RoomID: "ROOM9", Closed: true, ReportID: "rep-0"}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := s.HoldRoom(ctx, "ROOM9", "rep-2"); err != nil {
		t.Fatalf("HoldRoom: %v", err)
	}
	held, _, _ := s.Get(ctx, "ROOM9")
	if !held.Closed || !held.LegalHold || held.ReportID != "rep-0" {
		t.Fatalf("after HoldRoom = %+v; want closed, held, rep-0", held)
	}
}

func TestReportSubject_Consistent(t *testing.T) {
	for name, tc := range map[string]struct {
		r    ReportSubject
		want bool
	}{
		"member, same name":          {ReportSubject{Kind: "member", Name: "Ana", Content: "Ana"}, true},
		"member, suffixed label":     {ReportSubject{Kind: "member", Name: "Ana", Content: "Ana 2"}, true},
		"member, someone else":       {ReportSubject{Kind: "member", Name: "Bob", Content: "Mallory"}, false},
		"member, server saw nothing": {ReportSubject{Kind: "member", Content: "Ana"}, false},
		"message, same line":         {ReportSubject{Kind: "message", Text: "oi", Content: "oi"}, true},
		"message, other line":        {ReportSubject{Kind: "message", Text: "oi", Content: "coisa feia"}, false},
		"room":                       {ReportSubject{Kind: "room"}, false},
		"broadcast, server resolved": {ReportSubject{Kind: "broadcast", Sub: "sub-b"}, true},
		"broadcast, nobody resolved": {ReportSubject{Kind: "broadcast"}, false},
	} {
		if got := tc.r.Consistent(); got != tc.want {
			t.Errorf("%s: Consistent = %v, want %v", name, got, tc.want)
		}
	}
}
