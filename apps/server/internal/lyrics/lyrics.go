package lyrics

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"

	"github.com/LucasSantana-Dev/cojam/server/internal/httpx"
)

var (
	// LRCLIB endpoints (package-level for testability).
	// /api/get needs a close duration match; /api/search does not, so it is the
	// fallback when the queued track has no/imprecise duration.
	lrclibURL       = "https://lrclib.net/api/get"
	lrclibSearchURL = "https://lrclib.net/api/search"
)

// LyricLine represents a single lyric line with timing
type LyricLine struct {
	TimeMs int    `json:"timeMs"`
	Text   string `json:"text"`
}

// Lyrics represents parsed lyrics from LRCLIB
type Lyrics struct {
	Synced []LyricLine `json:"synced"`
	Plain  string      `json:"plain"`
	Source string      `json:"source"` // Always "lrclib"
}

// lrclibResponse is the raw response structure from LRCLIB API
type lrclibResponse struct {
	SyncedLyrics string `json:"syncedLyrics"`
	PlainLyrics  string `json:"plainLyrics"`
	Duration     int    `json:"duration"`
}

// parseLRCTimestamp parses a single LRC timestamp line like "[00:12.34] text"
// Returns (timeMs, text, error). Returns (0, "", nil) if the line doesn't match the format.
func parseLRCTimestamp(line string) (int, string, error) {
	line = strings.TrimSpace(line)
	if line == "" {
		return 0, "", nil
	}

	// Find the closing bracket
	endIdx := strings.Index(line, "]")
	if endIdx < 0 || !strings.HasPrefix(line, "[") {
		// Not a timestamped line
		return 0, "", nil
	}

	timeStr := line[1:endIdx]
	text := strings.TrimSpace(line[endIdx+1:])

	// Parse mm:ss.xx format
	parts := strings.Split(timeStr, ":")
	if len(parts) != 2 {
		return 0, "", nil
	}

	minutes, err := strconv.Atoi(strings.TrimSpace(parts[0]))
	if err != nil {
		return 0, "", nil
	}

	// Parse seconds.centiseconds
	secondsStr := strings.TrimSpace(parts[1])
	seconds, err := strconv.ParseFloat(secondsStr, 64)
	if err != nil {
		return 0, "", nil
	}

	timeMs := (minutes*60)*1000 + int(seconds*1000)
	return timeMs, text, nil
}

// FetchLyrics fetches lyrics for a track from LRCLIB.
// Returns a result (possibly empty synced/plain) for valid input,
// or an empty result if LRCLIB has no data.
func FetchLyrics(ctx context.Context, artist, title, album string, durationMs int) (*Lyrics, error) {
	result := &Lyrics{
		Synced: []LyricLine{},
		Plain:  "",
		Source: "lrclib",
	}

	// Require at least artist and title
	if artist == "" || title == "" {
		return result, nil
	}

	// Build LRCLIB query
	q := url.Values{}
	q.Set("artist_name", artist)
	q.Set("track_name", title)
	if album != "" {
		q.Set("album_name", album)
	}
	if durationMs > 0 {
		// Convert milliseconds to seconds for LRCLIB
		q.Set("duration", fmt.Sprintf("%d", durationMs/1000))
	}

	lrcURL := lrclibURL + "?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", lrcURL, nil)
	if err != nil {
		return result, nil // Graceful return on request creation error
	}
	req.Header.Set("User-Agent", "cojam/0.1 (https://github.com/LucasSantana-Dev/cojam)")

	// /api/get returns 404 on a duration mismatch (common for queue tracks). Treat
	// any error as a miss and fall through to /api/search, do NOT early-return.
	var resp lrclibResponse
	if err := httpx.DoJSON(req, &resp); err == nil {
		applyLRCResponse(result, resp)
		if len(result.Synced) > 0 || result.Plain != "" {
			return result, nil
		}
	}

	// /api/get missed (usually a duration mismatch on queue tracks). Fall back to
	// /api/search, which matches on artist+title alone and returns candidates.
	sq := url.Values{}
	sq.Set("artist_name", artist)
	sq.Set("track_name", title)
	sreq, err := http.NewRequestWithContext(ctx, "GET", lrclibSearchURL+"?"+sq.Encode(), nil)
	if err != nil {
		return result, nil
	}
	sreq.Header.Set("User-Agent", "cojam/0.1 (https://github.com/LucasSantana-Dev/cojam)")

	var hits []lrclibResponse
	if err := httpx.DoJSON(sreq, &hits); err != nil {
		return result, nil
	}
	// Prefer the first hit with synced lyrics; else the first with plain.
	var chosen *lrclibResponse
	for i := range hits {
		if hits[i].SyncedLyrics != "" {
			chosen = &hits[i]
			break
		}
		if chosen == nil && hits[i].PlainLyrics != "" {
			chosen = &hits[i]
		}
	}
	if chosen != nil {
		applyLRCResponse(result, *chosen)
	}
	return result, nil
}

// applyLRCResponse fills result.Synced/Plain from a raw LRCLIB response.
func applyLRCResponse(result *Lyrics, resp lrclibResponse) {
	if resp.SyncedLyrics != "" {
		for _, line := range strings.Split(resp.SyncedLyrics, "\n") {
			timeMs, text, err := parseLRCTimestamp(line)
			if err != nil || text == "" {
				continue
			}
			result.Synced = append(result.Synced, LyricLine{TimeMs: timeMs, Text: text})
		}
	}
	if resp.PlainLyrics != "" {
		result.Plain = resp.PlainLyrics
	}
}

// NewCachedLyricsFetcher returns a thread-safe in-memory cached fetcher.
// Cache key is normalized (artist|title|album|duration) to catch repeated queries.
// Caches nil results too: avoids re-querying dead tracks.
func NewCachedLyricsFetcher(inner func(ctx context.Context, artist, title, album string, durationMs int) (*Lyrics, error)) func(context.Context, string, string, string, int) (*Lyrics, error) {
	var mu sync.Mutex
	cache := make(map[string]*Lyrics)

	return func(ctx context.Context, artist, title, album string, durationMs int) (*Lyrics, error) {
		// Normalize cache key: lowercase, pipe-separated
		key := strings.ToLower(artist + "|" + title + "|" + album + "|" + fmt.Sprintf("%d", durationMs))

		mu.Lock()
		if cached, ok := cache[key]; ok {
			mu.Unlock()
			return cached, nil
		}
		mu.Unlock()

		// Cache miss: call inner fetcher
		result, err := inner(ctx, artist, title, album, durationMs)
		if err != nil {
			return nil, err
		}

		// Cache the result (including nil or empty) for next time
		mu.Lock()
		cache[key] = result
		mu.Unlock()

		return result, nil
	}
}
