package queue

import "context"

type durationKey struct{}

// WithDuration carries the catalogue duration of the track being matched, so a
// matcher can prefer a video of about that length without changing the Matcher
// signature. Zero or negative means unknown.
func WithDuration(ctx context.Context, ms int64) context.Context {
	return context.WithValue(ctx, durationKey{}, ms)
}

// DurationFrom returns the duration set by WithDuration (0 when unknown).
func DurationFrom(ctx context.Context) int64 {
	ms, _ := ctx.Value(durationKey{}).(int64)
	return ms
}
