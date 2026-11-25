package restrict

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/dbtest"
)

type fakeSource struct {
	mu    sync.Mutex
	calls int
	reads []func() ([]string, error)
}

func (f *fakeSource) ClosedRooms(context.Context) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	i := f.calls
	f.calls++
	if i >= len(f.reads) {
		i = len(f.reads) - 1
	}
	return f.reads[i]()
}

// A failed read never reaches the hub: the last known closed set stays in
// force, so a database blip cannot reopen a room.
func TestWatch_KeepsLastSetOnError(t *testing.T) {
	src := &fakeSource{reads: []func() ([]string, error){
		func() ([]string, error) { return []string{"ROOM1"}, nil },
		func() ([]string, error) { return nil, errors.New("db down") },
	}}
	var mu sync.Mutex
	var applied [][]string
	stop := Watch(src, 5*time.Millisecond, func(ids []string) {
		mu.Lock()
		applied = append(applied, ids)
		mu.Unlock()
	}, nil)
	deadline := time.Now().Add(2 * time.Second)
	for {
		src.mu.Lock()
		calls := src.calls
		src.mu.Unlock()
		if calls >= 4 || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	stop()

	mu.Lock()
	defer mu.Unlock()
	if len(applied) != 1 || len(applied[0]) != 1 || applied[0][0] != "ROOM1" {
		t.Fatalf("applied = %v, want only the first successful read", applied)
	}
}

// Put upserts, keeps created_at, and List/ClosedRooms see only rows with a
// flag set. Skips if TEST_DATABASE_URL is not set.
func TestPostgres_PutGetList(t *testing.T) {
	pool := dbtest.Isolated(t)
	ctx := context.Background()
	s := NewPostgres(pool)

	if _, ok, err := s.Get(ctx, "ROOM1"); err != nil || ok {
		t.Fatalf("Get of an untouched room = ok %v, err %v; want false, nil", ok, err)
	}
	if err := s.Put(ctx, Restriction{RoomID: "ROOM1", Closed: true, LegalHold: true, ReportID: "rep-1"}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := s.Put(ctx, Restriction{RoomID: "ROOM2", LegalHold: true}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	first, ok, err := s.Get(ctx, "ROOM1")
	if err != nil || !ok || !first.Closed || !first.LegalHold || first.ReportID != "rep-1" {
		t.Fatalf("Get = %+v, %v, %v", first, ok, err)
	}

	closed, err := s.ClosedRooms(ctx)
	if err != nil || len(closed) != 1 || closed[0] != "ROOM1" {
		t.Fatalf("ClosedRooms = %v, %v; want [ROOM1]", closed, err)
	}

	first.Closed = false
	if err := s.Put(ctx, first); err != nil {
		t.Fatalf("reopen: %v", err)
	}
	again, _, _ := s.Get(ctx, "ROOM1")
	if again.Closed || !again.LegalHold || !again.CreatedAt.Equal(first.CreatedAt) {
		t.Fatalf("after reopen = %+v; want open, held, same created_at", again)
	}
	if closed, _ := s.ClosedRooms(ctx); len(closed) != 0 {
		t.Fatalf("ClosedRooms after reopen = %v, want none", closed)
	}

	if err := s.Put(ctx, Restriction{RoomID: "ROOM2"}); err != nil {
		t.Fatalf("release: %v", err)
	}
	list, err := s.List(ctx)
	if err != nil || len(list) != 1 || list[0].RoomID != "ROOM1" {
		t.Fatalf("List = %+v, %v; want only ROOM1 (ROOM2 has no flag left)", list, err)
	}
}
