package match

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/hub"
	"time"
)

var (
	ErrNotConfigured = errors.New("service not configured")
	rateLimiter      = time.NewTicker(time.Second)
)

// MusicBrainzRecording represents a recording from MusicBrainz API
type MusicBrainzRecording struct {
	Title       string `json:"title"`
	Length      int    `json:"length"`
	ArtistCreds []struct {
		Artist struct {
			Name string `json:"name"`
		} `json:"artist"`
	} `json:"artist-credit"`
}

// MusicBrainzResponse wraps the recording data
type MusicBrainzResponse struct {
	IsRCs []struct {
		Recordings []MusicBrainzRecording `json:"recordings"`
	} `json:"isrcs"`
}

// MusicBrainzLookupISRC looks up a track by ISRC code
// Uses a package-level rate limiter (1 req/s)
func MusicBrainzLookupISRC(isrc string) (*MusicBrainzRecording, error) {
	if isrc == "" {
		return nil, errors.New("empty ISRC")
	}

	// Rate limit
	<-rateLimiter.C

	isrc = strings.ToUpper(isrc)
	mbURL := fmt.Sprintf("https://musicbrainz.org/ws/2/isrc/%s?fmt=json&inc=artist-credits", url.QueryEscape(isrc))

	req, err := http.NewRequest("GET", mbURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("User-Agent", "cojam/0.1 (dev)")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("unexpected status %d: %s", resp.StatusCode, string(body))
	}

	var mbResp MusicBrainzResponse
	if err := json.NewDecoder(resp.Body).Decode(&mbResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	if len(mbResp.IsRCs) == 0 || len(mbResp.IsRCs[0].Recordings) == 0 {
		return nil, errors.New("no recordings found")
	}

	return &mbResp.IsRCs[0].Recordings[0], nil
}

// YouTubeCandidate represents a YouTube search result
type YouTubeCandidate struct {
	VideoID    string  `json:"videoId"`
	Title      string  `json:"title"`
	Confidence float64 `json:"confidence"`
}

// YouTubeSearchResult wraps YouTube API response
type YouTubeSearchResult struct {
	Items []struct {
		ID struct {
			VideoID string `json:"videoId"`
		} `json:"id"`
		Snippet struct {
			Title string `json:"title"`
		} `json:"snippet"`
	} `json:"items"`
}

// YouTubeSearch searches YouTube for a track by query
// Requires YOUTUBE_API_KEY environment variable
func YouTubeSearch(query string) ([]YouTubeCandidate, error) {
	apiKey := os.Getenv("YOUTUBE_API_KEY")
	if apiKey == "" {
		return nil, ErrNotConfigured
	}

	q := url.Values{}
	q.Set("q", query)
	q.Set("type", "video")
	q.Set("maxResults", "5")
	q.Set("key", apiKey)
	q.Set("part", "snippet")

	searchURL := "https://www.googleapis.com/youtube/v3/search?" + q.Encode()

	req, err := http.NewRequest("GET", searchURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("unexpected status %d: %s", resp.StatusCode, string(body))
	}

	var result YouTubeSearchResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	candidates := make([]YouTubeCandidate, 0, len(result.Items))
	queryTokens := strings.Fields(strings.ToLower(query))

	for _, item := range result.Items {
		titleTokens := strings.Fields(strings.ToLower(item.Snippet.Title))
		confidence := calculateConfidence(queryTokens, titleTokens)

		candidates = append(candidates, YouTubeCandidate{
			VideoID:    item.ID.VideoID,
			Title:      item.Snippet.Title,
			Confidence: confidence,
		})
	}

	return candidates, nil
}

// calculateConfidence calculates token overlap confidence (0..1)
func calculateConfidence(queryTokens, titleTokens []string) float64 {
	if len(queryTokens) == 0 {
		return 0
	}

	matches := 0
	for _, qt := range queryTokens {
		for _, tt := range titleTokens {
			if qt == tt {
				matches++
				break
			}
		}
	}

	return float64(matches) / float64(len(queryTokens))
}

// MinConfidence gates auto-attach: below this, better no match than a wrong video.
const MinConfidence = 0.4

// MatcherFunc is the signature for track matchers: resolves a SourceRef for a track.

// ResolveYouTube is the hub.Matcher implementation: title+artist search,
// best candidate above MinConfidence wins. Returns (nil, nil) on no confident
// match, ErrNotConfigured when YOUTUBE_API_KEY is unset.
func ResolveYouTube(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error) {
	candidates, err := YouTubeSearch(title + " " + artist)
	if err != nil {
		return nil, err
	}
	var best *YouTubeCandidate
	for i := range candidates {
		if best == nil || candidates[i].Confidence > best.Confidence {
			best = &candidates[i]
		}
	}
	if best == nil || best.Confidence < MinConfidence {
		return nil, nil
	}
	return &queue.SourceRef{VideoID: best.VideoID, Confidence: best.Confidence}, nil
}

// NewCachedMatcher returns a thread-safe in-memory cached matcher wrapping the inner matcher.
// Cache key is normalized (title|artist|isrc) to catch repeated adds of the same track.
// Hit/miss events are signaled via onEvent callback (hit=true for cache hit, hit=false for cache miss).
// Caches nil results too: avoids re-querying dead tracks.
func NewCachedMatcher(inner hub.Matcher, onEvent func(hit bool)) hub.Matcher {
	var mu sync.Mutex
	cache := make(map[string]*queue.SourceRef)

	return func(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error) {
		// Normalize cache key: lowercase, pipe-separated
		key := strings.ToLower(title + "|" + artist + "|" + isrc)

		mu.Lock()
		if cached, ok := cache[key]; ok {
			mu.Unlock()
			onEvent(true) // cache hit
			return cached, nil
		}
		mu.Unlock()

		// Cache miss: call inner matcher
		result, err := inner(ctx, title, artist, isrc)
		if err != nil {
			return nil, err
		}

		// Cache the result (including nil) for next time
		mu.Lock()
		cache[key] = result
		mu.Unlock()

		onEvent(false) // cache miss
		return result, nil
	}
}

// init ensures rate limiter is running
func init() {
	// Ensure the ticker is consumed per second
	go func() {
		for range rateLimiter.C {
			// Just consume ticks to prevent channel backlog
		}
	}()
}
