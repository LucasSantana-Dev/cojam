package match

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
	_ "time/tzdata" // the zone database for America/Los_Angeles on minimal images

	"github.com/LucasSantana-Dev/cojam/server/internal/httpx"
	"github.com/LucasSantana-Dev/cojam/server/internal/hub"
)

// The YouTube Data API quota is per project and resets at midnight Pacific
// time. Once it is spent every search.list call fails, so the circuit breaker
// stops calling until then instead of burning requests (and log lines) on a
// certain failure.

// quotaNow is the clock, overridable in tests.
var quotaNow = time.Now

type quotaBreaker struct {
	mu    sync.Mutex
	until time.Time
}

var ytQuota quotaBreaker

// YouTubeQuotaUntil returns when searches may resume, or the zero time while
// the quota is not exhausted. Wire it into the hub (Hub.WithYouTubeQuota).
func YouTubeQuotaUntil() time.Time {
	ytQuota.mu.Lock()
	defer ytQuota.mu.Unlock()
	if !ytQuota.until.After(quotaNow()) {
		return time.Time{}
	}
	return ytQuota.until
}

// quotaExhaustedErr is the error returned while the breaker is open.
func quotaExhaustedErr(until time.Time) error {
	return fmt.Errorf("%w until %s", hub.ErrQuotaExhausted, until.UTC().Format(time.RFC3339))
}

// tripYouTubeQuota opens the breaker until the next quota reset and logs one
// WARN per trip (concurrent failures of the same outage log once).
func tripYouTubeQuota(now time.Time) time.Time {
	until := nextQuotaReset(now)
	ytQuota.mu.Lock()
	already := ytQuota.until.After(now)
	if !already {
		ytQuota.until = until
	}
	until = ytQuota.until
	ytQuota.mu.Unlock()
	if !already {
		slog.Warn("youtube_quota_exhausted", "until", until.UTC().Format(time.RFC3339))
	}
	return until
}

// resetYouTubeQuota closes the breaker (tests).
func resetYouTubeQuota() {
	ytQuota.mu.Lock()
	ytQuota.until = time.Time{}
	ytQuota.mu.Unlock()
}

// nextQuotaReset is the next midnight in America/Los_Angeles after now. The
// zone follows daylight saving, so the instant is 07:00 or 08:00 UTC.
func nextQuotaReset(now time.Time) time.Time {
	loc, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		loc = time.FixedZone("PST", -8*3600)
	}
	t := now.In(loc)
	return time.Date(t.Year(), t.Month(), t.Day()+1, 0, 0, 0, 0, loc)
}

// isQuotaError reports whether err is the YouTube API saying the quota is
// spent: HTTP 429, or 403 carrying a quota reason in the error body. Other
// 403s (a bad or restricted key) are not a quota problem.
func isQuotaError(err error) bool {
	var se *httpx.StatusError
	if !errors.As(err, &se) {
		return false
	}
	switch se.Code {
	case 429:
		return true
	case 403:
		var body struct {
			Error struct {
				Errors []struct {
					Reason string `json:"reason"`
				} `json:"errors"`
			} `json:"error"`
		}
		if json.Unmarshal(se.Body, &body) != nil {
			return false
		}
		for _, e := range body.Error.Errors {
			switch e.Reason {
			case "quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded":
				return true
			}
		}
	}
	return false
}
