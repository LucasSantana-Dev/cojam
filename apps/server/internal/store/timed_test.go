package store

import (
	"context"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

func TestTimedObservesSave(t *testing.T) {
	var n int
	s := Timed(NewMemory(), func(time.Duration) { n++ })
	if err := s.Save(context.Background(), &queue.RoomState{RoomID: "r1"}); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("observed %d saves, want 1", n)
	}
	if got, err := s.Load(context.Background(), "r1"); err != nil || got == nil {
		t.Fatalf("Load passthrough failed: %v", err)
	}
}
