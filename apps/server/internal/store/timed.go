package store

import (
	"context"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// Timed wraps a Store and reports the duration of every Save to observe
// (music_jam_store_save_duration_seconds). Every other method passes through.
func Timed(s Store, observe func(time.Duration)) Store {
	return &timedStore{Store: s, observe: observe}
}

type timedStore struct {
	Store
	observe func(time.Duration)
}

func (t *timedStore) Save(ctx context.Context, state *queue.RoomState) error {
	start := time.Now()
	err := t.Store.Save(ctx, state)
	t.observe(time.Since(start))
	return err
}
