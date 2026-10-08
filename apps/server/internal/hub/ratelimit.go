package hub

import (
	"sync"
	"time"
)

// fanoutMethods are RPCs that fan out to third-party APIs (search,
// lyrics, metadata enrichment, playlist fetch). They are rate-limited per
// caller so one client cannot burn through upstream provider quotas.
// playlist.import is mutating and host-only rather than a read, but with
// FEATURE_ROOM_AUTH off the host gate is skipped and a URL import calls
// Deezer/Spotify/YouTube with a 15s budget, so it draws from this bucket.
var fanoutMethods = map[string]bool{
	"track.search":       true,
	"track.lyrics":       true,
	"track.depth":        true,
	"track.listenbrainz": true,
	"track.lastfm":       true,
	"playlist.import":    true,
}

// voteMethods are vote RPCs (F4). Each accepted toggle republishes the full
// room state to every subscriber, so they get their own per-caller bucket,
// separate from fanoutMethods: that budget protects third-party API quotas
// and votes never leave the server.
var voteMethods = map[string]bool{
	"queue.vote": true,
}

// listMethods are unauthenticated directory reads that landing visitors poll.
// They get their own rate-limit bucket (separate from fanoutMethods: no
// third-party fanout, but still per-caller limited).
var listMethods = map[string]bool{
	"room.list": true,
}

// Defaults for the fanout rate limiter. Tests replace h.fanoutLimiter with a
// shrunken limiter instead of tuning these.
const (
	fanoutBurst      = 10               // requests a caller may fire at once
	fanoutRefill     = 2 * time.Second  // one token regained per interval
	fanoutIdleTTL    = 10 * time.Minute // buckets idle longer than this are evicted
	fanoutSweepEvery = time.Minute      // how often the lazy sweep runs
)

// Defaults for the vote rate limiter. Tests replace h.voteLimiter with a
// shrunken limiter instead of tuning these.
const (
	voteBurst  = 10              // toggles a caller may fire at once
	voteRefill = 2 * time.Second // one token regained per interval
)

// Defaults for the room.list limiter: burst 5, one token per 2s. Tests replace
// h.listLimiter with a shrunken limiter instead of tuning these.
const (
	listBurst  = 5
	listRefill = 2 * time.Second
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

// allowAll consumes one token from every key's bucket, or from none: it
// returns false, charging nothing, when any bucket is empty.
func (l *rateLimiter) allowAll(keys ...string) bool {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweepLocked(now)
	buckets := make([]*tokenBucket, 0, len(keys))
	for _, key := range keys {
		buckets = append(buckets, l.refillLocked(key, now))
	}
	for _, b := range buckets {
		if b.tokens < 1 {
			return false
		}
	}
	for _, b := range buckets {
		b.tokens--
	}
	return true
}

// allow consumes one token for key, returning false when the bucket is empty.
// Rejected calls do not consume a token. Idle buckets are evicted by a lazy
// sweep on access so the map cannot grow unboundedly.
func (l *rateLimiter) allow(key string) bool {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()

	l.sweepLocked(now)

	b := l.refillLocked(key, now)
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// mutationMethods are state-fanout RPCs: every accepted call bumps the room
// version and republishes the full RoomState to every subscriber, so they
// share one per-caller bucket. Methods already throttled elsewhere stay in
// their own bucket (queue.vote: voteMethods; transport.*: transportMethods;
// room.kick/chat.*: chatMethods; playlist.import: fanoutMethods).
var mutationMethods = map[string]bool{
	"queue.add":           true,
	"queue.remove":        true,
	"queue.reorder":       true,
	"now_playing.set":     true,
	"now_playing.advance": true,
	"radio.set":           true,
	"room.set_public":     true,
	"room.set_admin":      true,
	"room.transfer_host":  true,
	"room.claim_host":     true,
}

// Defaults for the mutation limiter: a host curating a queue clicks in
// bursts, so the burst is generous. Tests shrink h.mutationLimiter.
const (
	mutationBurst  = 20
	mutationRefill = time.Second
)

// checkMutationLimit enforces the per-caller bucket on mutationMethods.
func (h *Hub) checkMutationLimit(method, rlKey string) error {
	if !mutationMethods[method] || h.mutationLimiter == nil {
		return nil
	}
	if !h.mutationLimiter.allow(rlKey) {
		if h.metrics != nil {
			h.metrics.RateLimitReject(method)
		}
		return userErrorf("too many requests, slow down")
	}
	return nil
}

// refillLocked returns key's bucket, created full on first use and refilled
// for the time elapsed since its last access. Callers hold l.mu.
func (l *rateLimiter) refillLocked(key string, now time.Time) *tokenBucket {
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
	return b
}

// sweepLocked evicts idle buckets at most once per sweepEvery, so the map
// cannot grow unboundedly. Callers hold l.mu.
func (l *rateLimiter) sweepLocked(now time.Time) {
	if now.Sub(l.lastSweep) < l.sweepEvery {
		return
	}
	for k, b := range l.buckets {
		if now.Sub(b.last) > l.idleTTL {
			delete(l.buckets, k)
		}
	}
	l.lastSweep = now
}
