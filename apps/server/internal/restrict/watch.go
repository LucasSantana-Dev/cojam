package restrict

import (
	"context"
	"log/slog"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
)

// ClosedSource lists the closed rooms (Postgres in production).
type ClosedSource interface {
	ClosedRooms(ctx context.Context) ([]string, error)
}

// BlockedSource lists the blocked identities (Postgres in production).
type BlockedSource interface {
	BlockedUsers(ctx context.Context) ([]string, error)
}

// Watch loads the closed rooms once immediately and then every interval,
// handing each successful read to apply (the hub). A failed read is logged
// and skipped, so the last known set stays in force: a database blip never
// reopens a closed room. It returns a stop function that waits for the loop
// to exit, so shutdown can close the pool right after.
func Watch(src ClosedSource, interval time.Duration, apply func([]string), logger *slog.Logger) (stop func()) {
	return watch("room_restrictions", src.ClosedRooms, interval, apply, logger)
}

// WatchBlocked is Watch for person blocks: a failed read keeps the last
// blocked set, so once the first read has succeeded a database blip never
// lets a blocked person back in. Until then (a boot with the database down)
// nobody is blocked.
func WatchBlocked(src BlockedSource, interval time.Duration, apply func([]string), logger *slog.Logger) (stop func()) {
	return watch("person_blocks", src.BlockedUsers, interval, apply, logger)
}

func watch(name string, read func(context.Context) ([]string, error), interval time.Duration,
	apply func([]string), logger *slog.Logger) (stop func()) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	poll := func() {
		readCtx, cancelRead := context.WithTimeout(ctx, 10*time.Second)
		ids, err := read(readCtx)
		cancelRead()
		if err != nil {
			if logger != nil && ctx.Err() == nil {
				logger.Error(name+"_poll_failed", "err", err.Error())
			}
			return
		}
		apply(ids)
	}
	obs.SafeGo(name, func() {
		defer close(done)
		poll()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				poll()
			}
		}
	})
	return func() {
		cancel()
		<-done
	}
}
