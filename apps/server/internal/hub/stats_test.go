package hub

import (
	"testing"
	"time"
)

func TestLiveStats_AggregatesAllRoomsAndCaches(t *testing.T) {
	h := NewHub(nil)
	t0 := time.Now()

	if got := h.liveStatsAt(t0); got != (LiveStats{}) {
		t.Fatalf("empty hub = %+v, want zeros", got)
	}

	// Cached zero is served until the TTL passes, even as members join.
	h.Join("a", "room1")
	h.Join("b", "room1")
	h.Join("c", "hidden-room") // private rooms count in totals
	if got := h.liveStatsAt(t0.Add(liveStatsTTL - time.Second)); got != (LiveStats{}) {
		t.Fatalf("within TTL = %+v, want cached zeros", got)
	}

	want := LiveStats{People: 3, Rooms: 2}
	if got := h.liveStatsAt(t0.Add(liveStatsTTL)); got != want {
		t.Fatalf("after TTL = %+v, want %+v", got, want)
	}

	// Leaving is picked up on the next refresh; an emptied room stops counting.
	h.Leave("c")
	if got := h.liveStatsAt(t0.Add(liveStatsTTL + time.Second)); got != want {
		t.Fatalf("cached = %+v, want %+v", got, want)
	}
	if got := h.liveStatsAt(t0.Add(2 * liveStatsTTL)); got != (LiveStats{People: 2, Rooms: 1}) {
		t.Fatalf("after leave = %+v, want 2 people in 1 room", got)
	}
}
