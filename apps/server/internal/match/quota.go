package match

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
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
	daily bool // the open breaker is the daily quota, not a short pause
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

// YouTubeQuotaNoticeUntil is YouTubeQuotaUntil for the daily quota only: the
// time to tell clients "esgotada hoje". A short rate-limit pause pauses
// searches but returns the zero time here.
func YouTubeQuotaNoticeUntil() time.Time {
	ytQuota.mu.Lock()
	defer ytQuota.mu.Unlock()
	if !ytQuota.daily || !ytQuota.until.After(quotaNow()) {
		return time.Time{}
	}
	return ytQuota.until
}

// quotaExhaustedErr is the error returned while the breaker is open.
func quotaExhaustedErr(until time.Time) error {
	return fmt.Errorf("%w until %s", hub.ErrQuotaExhausted, until.UTC().Format(time.RFC3339))
}

// transientQuotaPause is how long a per-minute rate limit pauses searches.
const transientQuotaPause = 60 * time.Second

// tripYouTubeQuota opens the breaker until the given time and logs one WARN
// per trip (concurrent failures of the same outage log once). A later until
// extends an open breaker; an earlier one never shortens it.
func tripYouTubeQuota(now, until time.Time, kind quotaKind) time.Time {
	ytQuota.mu.Lock()
	already := ytQuota.until.After(now)
	if !already || until.After(ytQuota.until) {
		ytQuota.until, ytQuota.daily = until, kind == quotaDaily
	}
	until = ytQuota.until
	ytQuota.mu.Unlock()
	if !already {
		slog.Warn("youtube_quota_exhausted", "until", until.UTC().Format(time.RFC3339), "kind", kind.String())
	}
	return until
}

// tripFor classifies err and opens the breaker accordingly: a daily quota
// until the next midnight Pacific, a transient rate limit for about a minute.
// It returns the until time and whether err was a quota error at all.
func tripFor(err error, now time.Time) (time.Time, bool) {
	kind := classifyQuotaError(err)
	switch kind {
	case quotaDaily:
		return tripYouTubeQuota(now, nextQuotaReset(now), kind), true
	case quotaTransient:
		return tripYouTubeQuota(now, now.Add(transientQuotaPause), kind), true
	}
	return time.Time{}, false
}

// resetYouTubeQuota closes the breaker (tests).
func resetYouTubeQuota() {
	ytQuota.mu.Lock()
	ytQuota.until, ytQuota.daily = time.Time{}, false
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

type quotaKind int

const (
	quotaNone quotaKind = iota
	quotaDaily
	quotaTransient
)

func (k quotaKind) String() string {
	switch k {
	case quotaDaily:
		return "daily"
	case quotaTransient:
		return "transient"
	}
	return "none"
}

// classifyQuotaError tells the daily quota apart from a transient rate limit.
// Google answers both with 429/403 and often reason rateLimitExceeded, so the
// message decides: "...Search Queries per day" is the daily quota. Daily means
// reason quotaExceeded or dailyLimitExceeded, or a message naming "per day".
// Any other 429, or reason rateLimitExceeded, is transient. A 403 without a
// quota reason (a bad or restricted key) is not a quota problem.
func classifyQuotaError(err error) quotaKind {
	var se *httpx.StatusError
	if !errors.As(err, &se) || (se.Code != 429 && se.Code != 403) {
		return quotaNone
	}
	var body struct {
		Error struct {
			Message string `json:"message"`
			Errors  []struct {
				Reason  string `json:"reason"`
				Message string `json:"message"`
			} `json:"errors"`
		} `json:"error"`
	}
	_ = json.Unmarshal(se.Body, &body)
	daily, rate := false, false
	msgs := []string{body.Error.Message}
	for _, e := range body.Error.Errors {
		msgs = append(msgs, e.Message)
		switch e.Reason {
		case "quotaExceeded", "dailyLimitExceeded":
			daily = true
		case "rateLimitExceeded":
			rate = true
		}
	}
	for _, m := range msgs {
		if strings.Contains(strings.ToLower(m), "per day") {
			daily = true
		}
	}
	switch {
	case daily:
		return quotaDaily
	case se.Code == 429 || rate:
		return quotaTransient
	}
	return quotaNone
}

// isQuotaError reports whether err is any kind of YouTube quota refusal.
func isQuotaError(err error) bool { return classifyQuotaError(err) != quotaNone }
