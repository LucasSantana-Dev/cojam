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

// Watch loads the closed rooms once immediately and then every interval,
// handing each successful read to apply (the hub). A failed read is logged
// and skipped, so the last known set stays in force: a database blip never
// reopens a closed room. It returns a stop function that waits for the loop
// to exit, so shutdown can close the pool right after.
func Watch(src ClosedSource, interval time.Duration, apply func([]string), logger *slog.Logger) (stop func()) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	poll := func() {
		readCtx, cancelRead := context.WithTimeout(ctx, 10*time.Second)
		ids, err := src.ClosedRooms(readCtx)
		cancelRead()
		if err != nil {
			if logger != nil && ctx.Err() == nil {
				logger.Error("room_restrictions_poll_failed", "err", err.Error())
			}
			return
		}
		apply(ids)
	}
	obs.SafeGo("room_restrictions", func() {
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
