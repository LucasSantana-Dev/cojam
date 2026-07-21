package hub

import (
	"sync"
	"time"
)

// fanoutMethods are read RPCs that fan out to third-party APIs (search,
// lyrics, metadata enrichment). They are rate-limited per caller so one
// client cannot burn through upstream provider quotas.
var fanoutMethods = map[string]bool{
	"track.search":       true,
	"track.lyrics":       true,
	"track.depth":        true,
	"track.listenbrainz": true,
	"track.lastfm":       true,
}

// Defaults for the fanout rate limiter. Tests replace h.fanoutLimiter with a
// shrunken limiter instead of tuning these.
const (
	fanoutBurst      = 10               // requests a caller may fire at once
	fanoutRefill     = 2 * time.Second  // one token regained per interval
	fanoutIdleTTL    = 10 * time.Minute // buckets idle longer than this are evicted
	fanoutSweepEvery = time.Minute      // how often the lazy sweep runs
)

// tokenBucket is a single caller's token bucket. Refill is computed lazily
// from elapsed time, so there is no background goroutine.
type tokenBucket struct {
	tokens float64
	last   time.Time
}

// rateLimiter is a per-key token bucket limiter. The clock is injectable so
// tests can simulate refill without sleeping.
type rateLimiter struct {
	mu         sync.Mutex
	buckets    map[string]*tokenBucket
	burst      float64
	refill     time.Duration
	idleTTL    time.Duration
	sweepEvery time.Duration
	lastSweep  time.Time
	now        func() time.Time
}

func newRateLimiter(burst int, refill time.Duration, now func() time.Time) *rateLimiter {
	return &rateLimiter{
		buckets:    make(map[string]*tokenBucket),
		burst:      float64(burst),
		refill:     refill,
		idleTTL:    fanoutIdleTTL,
		sweepEvery: fanoutSweepEvery,
		now:        now,
	}
}

// allow consumes one token for key, returning false when the bucket is empty.
// Rejected calls do not consume a token. Idle buckets are evicted by a lazy
// sweep on access so the map cannot grow unboundedly.
func (l *rateLimiter) allow(key string) bool {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()

	if now.Sub(l.lastSweep) >= l.sweepEvery {
		for k, b := range l.buckets {
			if now.Sub(b.last) > l.idleTTL {
				delete(l.buckets, k)
			}
		}
		l.lastSweep = now
	}

	b, ok := l.buckets[key]
	if !ok {
		b = &tokenBucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}

	b.tokens += float64(now.Sub(b.last)) / float64(l.refill)
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
