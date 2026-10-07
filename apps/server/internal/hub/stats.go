package hub

import (
	"sync"
	"time"
)

// liveStatsTTL bounds how stale the public live counter may be. The counter
// is unauthenticated and scraped by every landing visit, so it must not walk
// the member index per request (#307).
const liveStatsTTL = 10 * time.Second

// LiveStats is the aggregate shown as "N people in rooms right now". Totals
// only: it carries no room ids, names or per-room counts, so private rooms
// contribute to the numbers without being identifiable.
type LiveStats struct {
	People int `json:"people"`
	Rooms  int `json:"rooms"`
}

type liveStatsCache struct {
	mu      sync.Mutex
	value   LiveStats
	expires time.Time
}

// LiveStats returns the cached aggregate, recomputing at most once per
// liveStatsTTL. People counts connections enrolled in a room (two tabs count
// twice, same caveat as memberCount); Rooms counts rooms with at least one.
func (h *Hub) LiveStats() LiveStats {
	return h.liveStatsAt(time.Now())
}

func (h *Hub) liveStatsAt(now time.Time) LiveStats {
	c := &h.liveStats
	c.mu.Lock()
	defer c.mu.Unlock()
	if now.Before(c.expires) {
		return c.value
	}
	h.memberMu.RLock()
	var s LiveStats
	for _, members := range h.roomMembers {
		if n := len(members); n > 0 {
			s.People += n
			s.Rooms++
		}
	}
	h.memberMu.RUnlock()
	c.value = s
	c.expires = now.Add(liveStatsTTL)
	return s
}
