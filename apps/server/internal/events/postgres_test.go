package events_test

import (
	"context"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/dbtest"
	"github.com/LucasSantana-Dev/cojam/server/internal/events"
)

// Runs against TEST_DATABASE_URL (skipped without it): the real INSERT shape,
// NULL handling, jsonb, and the retention statement.
func TestPostgres_InsertAndPurge(t *testing.T) {
	pool := dbtest.Isolated(t)
	ctx := context.Background()
	pg := events.NewPostgres(pool)

	old := time.Now().Add(-400 * 24 * time.Hour)
	recent := time.Now().Add(-24 * time.Hour)
	rows := []events.Row{
		{At: old, Name: events.RoomCreated, RoomHash: "aaaa", Props: []byte(`{}`)},
		{At: old, Name: events.TrackLiked, RoomHash: "aaaa", ActorHash: "bbbb", Props: []byte(`{}`)},
		{At: recent, Name: events.TrackStarted, RoomHash: "cccc", Props: []byte(`{"provider":"youtube","source":"manual"}`)},
		{At: recent, Name: events.Search, Props: []byte(`{"provider":"catalog","cache_hit":false}`)},
	}
	if err := pg.InsertEvents(ctx, rows); err != nil {
		t.Fatalf("insert: %v", err)
	}

	var nullRooms, nullActors int
	if err := pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE room_hash IS NULL), count(*) FILTER (WHERE actor_hash IS NULL) FROM product_events`).Scan(&nullRooms, &nullActors); err != nil {
		t.Fatal(err)
	}
	if nullRooms != 1 || nullActors != 3 {
		t.Fatalf("empty hashes must be NULL: null rooms=%d actors=%d", nullRooms, nullActors)
	}
	var src string
	if err := pool.QueryRow(ctx, `SELECT props->>'source' FROM product_events WHERE name = 'track_started'`).Scan(&src); err != nil || src != "manual" {
		t.Fatalf("props jsonb = %q, %v", src, err)
	}

	// Retention: only rows older than the cutoff go, oldest first, bounded.
	cutoff := time.Now().Add(-396 * 24 * time.Hour)
	n, err := pg.PurgeBefore(ctx, cutoff, 1)
	if err != nil || n != 1 {
		t.Fatalf("bounded purge removed %d, %v; want 1", n, err)
	}
	n, err = pg.PurgeBefore(ctx, cutoff, 100)
	if err != nil || n != 1 {
		t.Fatalf("second purge removed %d, %v; want 1", n, err)
	}
	var left int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM product_events`).Scan(&left); err != nil || left != 2 {
		t.Fatalf("rows left = %d, %v; want the 2 recent ones", left, err)
	}
}

// A Writer on the real table: flush and read back.
func TestWriterWritesToPostgres(t *testing.T) {
	pool := dbtest.Isolated(t)
	ctx := context.Background()
	w := events.NewWriter(events.NewHasher([]byte("k")), events.NewPostgres(pool), nil, nil, events.Config{})
	w.Emit(events.Event{Name: events.RoomJoined, RoomID: "clear-room", ActorID: "user:clear-user"})
	w.Flush(ctx)
	var room, actor string
	if err := pool.QueryRow(ctx, `SELECT room_hash, actor_hash FROM product_events`).Scan(&room, &actor); err != nil {
		t.Fatal(err)
	}
	if room == "clear-room" || actor == "user:clear-user" || len(room) != 32 || len(actor) != 32 {
		t.Fatalf("stored ids must be 32-char digests: %q %q", room, actor)
	}
}
