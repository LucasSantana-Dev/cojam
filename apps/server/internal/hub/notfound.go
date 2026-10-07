package hub

import (
	"sync"
	"time"
)

// notFoundTTL is how long a "room not found in the store" answer is reused.
// Read-only lookups (host checks) on rooms that exist nowhere would otherwise
// cost one store query per RPC. Creating the room clears its entry.
const notFoundTTL = 30 * time.Second

// notFoundMax bounds the cache; when full, expired entries are swept and, if
// it is still full, new misses are simply not cached.
const notFoundMax = 10000

// notFoundCache remembers room ids recently confirmed absent from the store.
type notFoundCache struct {
	mu      sync.Mutex
	entries map[string]time.Time // roomID -> expiry
	max     int
	now     func() time.Time
}

func newNotFoundCache(max int) *notFoundCache {
	return &notFoundCache{entries: make(map[string]time.Time), max: max, now: time.Now}
}

// has reports whether roomID is cached as absent and not yet expired.
func (c *notFoundCache) has(roomID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	exp, ok := c.entries[roomID]
	if !ok {
		return false
	}
	if c.now().After(exp) {
		delete(c.entries, roomID)
		return false
	}
	return true
}

// add caches roomID as absent for notFoundTTL.
func (c *notFoundCache) add(roomID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.max <= 0 {
		return
	}
	now := c.now()
	if len(c.entries) >= c.max {
		for id, exp := range c.entries {
			if now.After(exp) {
				delete(c.entries, id)
			}
		}
		if len(c.entries) >= c.max {
			return
		}
	}
	c.entries[roomID] = now.Add(notFoundTTL)
}

// forget drops roomID (the room now exists).
func (c *notFoundCache) forget(roomID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, roomID)
}

func (c *notFoundCache) len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}
