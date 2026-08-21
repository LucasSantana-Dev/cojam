package report

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestKind_Valid(t *testing.T) {
	for _, k := range []Kind{KindMessage, KindMember, KindRoom} {
		if !k.Valid() {
			t.Errorf("%q should be valid", k)
		}
	}
	for _, k := range []Kind{"", "bogus", "MESSAGE", "../../etc"} {
		if Kind(k).Valid() {
			t.Errorf("%q should be rejected", k)
		}
	}
}

func TestMemory_RejectsInvalidKind(t *testing.T) {
	err := NewMemory().Create(context.Background(), Report{ID: "x", Kind: Kind("bogus")})
	if !errors.Is(err, ErrInvalidKind) {
		t.Fatalf("expected ErrInvalidKind, got %v", err)
	}
}

func TestMemory_KeepsContentAndReturnsNewestFirst(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()

	for _, id := range []string{"a", "b"} {
		if err := m.Create(ctx, Report{
			ID: id, RoomID: "R1", Kind: KindMessage,
			Content: "copy of " + id, CreatedAt: time.Now(),
		}); err != nil {
			t.Fatalf("Create %s: %v", id, err)
		}
	}

	got, err := m.Recent(ctx, 10)
	if err != nil || len(got) != 2 {
		t.Fatalf("Recent: %d, %v", len(got), err)
	}
	if got[0].ID != "b" {
		t.Fatalf("expected newest first, got %s", got[0].ID)
	}
	// The copy is the whole point: the original line may already be gone.
	if got[0].Content != "copy of b" {
		t.Fatalf("expected the copied content, got %q", got[0].Content)
	}
}

func TestMemoryAudit_RecordsActorAndSubject(t *testing.T) {
	ctx := context.Background()
	a := NewMemoryAudit()

	if err := a.Record(ctx, Action{
		ID: "act-1", RoomID: "R1", Action: "chat.delete",
		ActorUserID: "host-sub", SubjectID: "m-1", CreatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("Record: %v", err)
	}

	got, err := a.RecentActions(ctx, 10)
	if err != nil || len(got) != 1 {
		t.Fatalf("RecentActions: %d, %v", len(got), err)
	}
	// "by whom" is the point of an audit trail.
	if got[0].ActorUserID != "host-sub" || got[0].SubjectID != "m-1" {
		t.Fatalf("expected actor and subject recorded, got %+v", got[0])
	}
}

func TestMemoryAudit_NewestFirstAndLimited(t *testing.T) {
	ctx := context.Background()
	a := NewMemoryAudit()
	for _, id := range []string{"1", "2", "3"} {
		_ = a.Record(ctx, Action{ID: id, Action: "room.kick", CreatedAt: time.Now()})
	}
	got, _ := a.RecentActions(ctx, 2)
	if len(got) != 2 || got[0].ID != "3" || got[1].ID != "2" {
		t.Fatalf("expected the two newest, got %+v", got)
	}
}
