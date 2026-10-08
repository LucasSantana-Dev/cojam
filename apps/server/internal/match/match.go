package match

import (
	"container/list"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/httpx"
	"github.com/LucasSantana-Dev/cojam/server/internal/hub"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/spotifyauth"
)

var (
	ErrNotConfigured = errors.New("service not configured")

	// MusicBrainz base URL (package-level for testability)
	musicbrainzURL = "https://musicbrainz.org/ws/2"

	// YouTube Data API endpoints (package-level for testability)
	youtubeSearchURL = "https://www.googleapis.com/youtube/v3/search"
	youtubeVideosURL = "https://www.googleapis.com/youtube/v3/videos"
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

// TrackDepthCredit represents a person involved in the track (role + name)
type TrackDepthCredit struct {
	Role string `json:"role"`
	Name string `json:"name"`
}

// TrackDepth represents deep metadata about a track from MusicBrainz
type TrackDepth struct {
	Credits     []TrackDepthCredit `json:"credits"`
	ReleaseYear int                `json:"releaseYear,omitempty"`
	Label       string             `json:"label,omitempty"`
	Tags        []string           `json:"tags"`
	Source      string             `json:"source"` // Always "musicbrainz"
}

// MusicBrainzLookupISRC looks up a track by ISRC code
// Uses a package-level rate limiter (1 req/s)
func MusicBrainzLookupISRC(isrc string) (*MusicBrainzRecording, error) {
	if isrc == "" {
		return nil, errors.New("empty ISRC")
	}

	if err := waitMusicBrainz(context.Background()); err != nil {
		return nil, err
	}

	isrc = strings.ToUpper(isrc)
	mbURL := fmt.Sprintf("https://musicbrainz.org/ws/2/isrc/%s?fmt=json&inc=artist-credits", url.QueryEscape(isrc))

	req, err := http.NewRequest("GET", mbURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("User-Agent", mbUserAgent)

	var mbResp MusicBrainzResponse
	if err := httpx.DoJSON(req, &mbResp); err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
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
	// DurationMs is the video's real length from videos.list contentDetails;
	// 0 when unknown (the lookup failed or the video is live).
	DurationMs int64 `json:"durationMs,omitempty"`
	// Live marks a live stream or premiere (videos.list reports P0D): never a
	// song to sync against, distinct from a failed lookup (Live false, 0 ms).
	Live bool `json:"live,omitempty"`
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
	return YouTubeSearchContext(context.Background(), query)
}

// redactErr drops the request URL from a transport error: *url.Error embeds it,
// and the URL carries the API key (key=...), which must never reach logs, the
// match_miss line or an RPC error.
func redactErr(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return fmt.Errorf("%s: %w", ue.Op, ue.Err)
	}
	return err
}

// YouTubeSearchContext is YouTubeSearch bound to ctx, so the matcher's own
// deadline also bounds the HTTP calls.
func YouTubeSearchContext(ctx context.Context, query string) ([]YouTubeCandidate, error) {
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

	searchURL := youtubeSearchURL + "?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", searchURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", redactErr(err))
	}

	var result YouTubeSearchResult
	if err := httpx.DoJSON(req, &result); err != nil {
		return nil, fmt.Errorf("request failed: %w", redactErr(err))
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

	fillDurations(ctx, apiKey, candidates)
	return candidates, nil
}

// youtubeVideosResult is the videos.list contentDetails response.
type youtubeVideosResult struct {
	Items []struct {
		ID             string `json:"id"`
		ContentDetails struct {
			Duration string `json:"duration"`
		} `json:"contentDetails"`
	} `json:"items"`
}

// fillDurations sets DurationMs on the candidates with ONE batched videos.list
// call (1 quota unit for all of them; search.list does not carry durations).
// Best effort: on any failure the durations stay 0 (unknown) and the caller
// falls back to title confidence alone.
func fillDurations(ctx context.Context, apiKey string, candidates []YouTubeCandidate) {
	if len(candidates) == 0 {
		return
	}
	ids := make([]string, 0, len(candidates))
	for _, c := range candidates {
		ids = append(ids, c.VideoID)
	}
	q := url.Values{}
	q.Set("part", "contentDetails")
	q.Set("id", strings.Join(ids, ","))
	q.Set("key", apiKey)
	req, err := http.NewRequestWithContext(ctx, "GET", youtubeVideosURL+"?"+q.Encode(), nil)
	if err != nil {
		slog.Warn("youtube_duration_lookup_failed", "err", redactErr(err).Error())
		return
	}
	var res youtubeVideosResult
	if err := httpx.DoJSON(req, &res); err != nil {
		slog.Warn("youtube_duration_lookup_failed", "err", redactErr(err).Error())
		return
	}
	type dur struct {
		ms   int64
		live bool
	}
	byID := make(map[string]dur, len(res.Items))
	for _, it := range res.Items {
		ms := parseISO8601DurationMs(it.ContentDetails.Duration)
		byID[it.ID] = dur{ms: ms, live: it.ContentDetails.Duration != "" && ms == 0}
	}
	for i := range candidates {
		d := byID[candidates[i].VideoID]
		candidates[i].DurationMs, candidates[i].Live = d.ms, d.live
	}
}

// parseISO8601DurationMs parses the YouTube "P1DT2H3M4S" form. "P0D" (a live
// stream) and anything unreadable give 0; the caller tells a live stream apart
// from a failed lookup by the field being present.
func parseISO8601DurationMs(s string) int64 {
	if !strings.HasPrefix(s, "P") {
		return 0
	}
	var total, num int64
	inTime := false
	for _, r := range s[1:] {
		switch {
		case r >= '0' && r <= '9':
			num = num*10 + int64(r-'0')
		case r == 'T':
			inTime = true
		case r == 'D' && !inTime:
			total, num = total+num*86400, 0
		case r == 'H' && inTime:
			total, num = total+num*3600, 0
		case r == 'M' && inTime:
			total, num = total+num*60, 0
		case r == 'S' && inTime:
			total, num = total+num, 0
		default:
			return 0
		}
	}
	return total * 1000
}

// Duration bounds for picking a video (ms). A search hit by title alone can be
// an hour-long loop or compilation: with a known catalogue duration the video
// must be within +-35% or 90 s of it (whichever is wider). With none, videos of
// preferredUnknownDurationMs or less win, and a longer one (a DJ set, a long
// piece) is only a fallback, never rejected outright.
const (
	durationToleranceFrac      = 0.35
	durationToleranceMs        = 90_000
	preferredUnknownDurationMs = 15 * 60 * 1000
)

// durationOK reports whether a candidate's length is plausible for a track of
// a KNOWN catalogue length. A candidate whose duration is unknown (0, failed
// lookup) is not rejected.
func durationOK(candidateMs, catalogueMs int64) bool {
	if candidateMs <= 0 || catalogueMs <= 0 {
		return true
	}
	tol := int64(float64(catalogueMs) * durationToleranceFrac)
	if tol < durationToleranceMs {
		tol = durationToleranceMs
	}
	diff := candidateMs - catalogueMs
	if diff < 0 {
		diff = -diff
	}
	return diff <= tol
}

// pickCandidate chooses the highest-confidence candidate that is not live and
// whose length fits. Tradeoff: filtering by duration can promote a weaker title
// match (a cover or a live take of the right length) over the better-titled
// video of the wrong length; that is intended, a wrong length breaks sync.
func pickCandidate(candidates []YouTubeCandidate, catalogueMs int64) *YouTubeCandidate {
	pick := func(ok func(c *YouTubeCandidate) bool) *YouTubeCandidate {
		var best *YouTubeCandidate
		for i := range candidates {
			c := &candidates[i]
			if c.Live || !ok(c) {
				continue
			}
			if best == nil || c.Confidence > best.Confidence {
				best = c
			}
		}
		return best
	}
	if catalogueMs > 0 {
		return pick(func(c *YouTubeCandidate) bool { return durationOK(c.DurationMs, catalogueMs) })
	}
	if best := pick(func(c *YouTubeCandidate) bool { return c.DurationMs <= preferredUnknownDurationMs }); best != nil && best.Confidence >= MinConfidence {
		return best
	}
	return pick(func(*YouTubeCandidate) bool { return true })
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
	candidates, err := searchYouTubeCached(ctx, title+" "+artist)
	if err != nil {
		return nil, err
	}
	best := pickCandidate(candidates, queue.DurationFrom(ctx))
	if best == nil || best.Confidence < MinConfidence {
		return nil, nil
	}
	return &queue.SourceRef{VideoID: best.VideoID, Confidence: best.Confidence}, nil
}

// searchCache holds search results WITH their durations, keyed by the query
// alone: the catalogue duration differs by provider (215.9 s vs 216.0 s), so it
// is applied after the cache and never part of the key. Errors are not cached.
var searchCache = struct {
	sync.Mutex
	m map[string]searchEntry
}{m: map[string]searchEntry{}}

type searchEntry struct {
	cands     []YouTubeCandidate
	expiresAt time.Time
}

func searchYouTubeCached(ctx context.Context, query string) ([]YouTubeCandidate, error) {
	key := strings.ToLower(query)
	searchCache.Lock()
	e, ok := searchCache.m[key]
	searchCache.Unlock()
	if ok && time.Now().Before(e.expiresAt) {
		return append([]YouTubeCandidate(nil), e.cands...), nil
	}
	cands, err := YouTubeSearchContext(ctx, query)
	if err != nil {
		return nil, err
	}
	searchCache.Lock()
	if len(searchCache.m) >= CacheMaxEntries {
		now := time.Now()
		for k, v := range searchCache.m {
			if now.After(v.expiresAt) {
				delete(searchCache.m, k)
			}
		}
		if len(searchCache.m) >= CacheMaxEntries {
			searchCache.m = map[string]searchEntry{}
		}
	}
	searchCache.m[key] = searchEntry{cands: append([]YouTubeCandidate(nil), cands...), expiresAt: time.Now().Add(CacheTTL)}
	searchCache.Unlock()
	return cands, nil
}

// Bounds for the matcher cache. TTL applies to hits and misses alike: both go
// stale (a miss can start matching, a hit can point at a deleted video).
var (
	CacheMaxEntries = 10000
	CacheTTL        = 24 * time.Hour
)

type cacheEntry struct {
	key       string
	val       *queue.SourceRef
	expiresAt time.Time
}

// matchCache is an LRU with a per-entry TTL, bounded at CacheMaxEntries.
// Every cache-key input is caller-controlled, so an unbounded map would grow
// for the life of the process.
type matchCache struct {
	mu    sync.Mutex
	order *list.List // most-recent-first
	index map[string]*list.Element
}

func newMatchCache() *matchCache {
	return &matchCache{order: list.New(), index: make(map[string]*list.Element)}
}

// get returns the cached value and whether it was a live hit. An expired entry
// is dropped and reported as a miss.
func (c *matchCache) get(key string) (*queue.SourceRef, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	el, ok := c.index[key]
	if !ok {
		return nil, false
	}
	entry := el.Value.(*cacheEntry)
	if time.Now().After(entry.expiresAt) {
		c.remove(el)
		return nil, false
	}
	c.order.MoveToFront(el)
	return entry.val, true
}

func (c *matchCache) put(key string, val *queue.SourceRef) {
	c.mu.Lock()
	defer c.mu.Unlock()

	expiresAt := time.Now().Add(CacheTTL)
	if el, ok := c.index[key]; ok {
		entry := el.Value.(*cacheEntry)
		entry.val, entry.expiresAt = val, expiresAt
		c.order.MoveToFront(el)
		return
	}
	c.index[key] = c.order.PushFront(&cacheEntry{key: key, val: val, expiresAt: expiresAt})
	for c.order.Len() > CacheMaxEntries {
		c.remove(c.order.Back())
	}
}

// remove unlinks el. Caller holds mu.
func (c *matchCache) remove(el *list.Element) {
	if el == nil {
		return
	}
	c.order.Remove(el)
	delete(c.index, el.Value.(*cacheEntry).key)
}

// NewCachedMatcher returns a thread-safe in-memory cached matcher wrapping the inner matcher.
// Cache key is normalized (title|artist|isrc) to catch repeated adds of the same track.
// Hit/miss events are signaled via onEvent callback (hit=true for cache hit, hit=false for cache miss).
// Caches nil results too: avoids re-querying dead tracks.
func NewCachedMatcher(inner hub.Matcher, onEvent func(hit bool)) hub.Matcher {
	cache := newMatchCache()

	return func(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error) {
		key := strings.ToLower(title+"|"+artist+"|"+isrc) + fmt.Sprintf("|%d", queue.DurationFrom(ctx)/1000)

		if val, hit := cache.get(key); hit {
			onEvent(true)
			return val, nil
		}

		result, err := inner(ctx, title, artist, isrc)
		if err != nil {
			return nil, err
		}

		cache.put(key, result)
		onEvent(false)
		return result, nil
	}
}

// Spotify matcher implementation

// Package-level vars for testability (can be overridden in tests)
var (
	// Spotify search URL (token is now in spotifyauth package)
	spotifySearchURL = "https://api.spotify.com/v1/search"

	// Deezer vars (no auth needed, public API)
	deezerSearchURL = "https://api.deezer.com/search"

	// Last.fm vars
	lastfmAPIKey = os.Getenv("LASTFM_API_KEY")
	lastfmURL    = "http://ws.audioscrobbler.com/2.0/"
)

// tokenCacheEntry holds a cached access token with expiry info
type tokenCacheEntry struct {
	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

// SpotifyTrack represents a Spotify track from search results
type SpotifyTrack struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	URI   string `json:"uri"`
	Album struct {
		Name   string `json:"name"`
		Images []struct {
			URL string `json:"url"`
		} `json:"images"`
	} `json:"album"`
	Artists []struct {
		Name string `json:"name"`
	} `json:"artists"`
	ExternalIDs struct {
		ISRC string `json:"isrc"`
	} `json:"external_ids"`
	DurationMs int `json:"duration_ms"`
}

// SpotifySearchResult wraps Spotify search response
type SpotifySearchResult struct {
	Tracks struct {
		Items []SpotifyTrack `json:"items"`
	} `json:"tracks"`
}

// ResolveSpotify is the hub.Matcher implementation for Spotify:
// searches Spotify for a track by ISRC (if provided) or title+artist.
// Returns a SourceRef with TrackURI on confident match, (nil, nil) on no match.
func ResolveSpotify(ctx context.Context, title, artist, isrc string) (*queue.SourceRef, error) {
	// Get access token
	token, err := spotifyauth.Token(ctx)
	if errors.Is(err, spotifyauth.ErrNotConfigured) {
		return nil, ErrNotConfigured
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get spotify token: %w", err)
	}

	// Build search query: ISRC-first, then title+artist
	var query string
	if isrc != "" {
		query = fmt.Sprintf("isrc:%s", isrc)
	} else {
		query = title + " " + artist
	}

	// Search Spotify
	searchReq, err := http.NewRequestWithContext(ctx, "GET", spotifySearchURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create search request: %w", err)
	}

	q := searchReq.URL.Query()
	q.Set("q", query)
	q.Set("type", "track")
	q.Set("limit", "5")
	searchReq.URL.RawQuery = q.Encode()

	searchReq.Header.Set("Authorization", fmt.Sprintf("Bearer %s", token))

	var result SpotifySearchResult
	if err := httpx.DoJSON(searchReq, &result); err != nil {
		return nil, fmt.Errorf("search request failed: %w", err)
	}

	if len(result.Tracks.Items) == 0 {
		return nil, nil
	}

	// ISRC is an exact identifier: a track returned for an isrc: query IS the
	// match, so trust it at full confidence. (Scoring it by token overlap would
	// wrongly reject matches whose canonical Spotify title differs, e.g. a
	// "- Remastered" suffix.)
	if isrc != "" {
		best := result.Tracks.Items[0]
		return &queue.SourceRef{TrackURI: best.URI, Confidence: 1.0}, nil
	}

	// Title/artist fallback: score token overlap against the REAL title+artist
	// the caller passed (not the raw query string), best above MinConfidence wins.
	wantTokens := strings.Fields(strings.ToLower(title + " " + artist))
	var best *SpotifyTrack
	var bestConfidence float64
	for i := range result.Tracks.Items {
		track := &result.Tracks.Items[i]
		artistName := ""
		if len(track.Artists) > 0 {
			artistName = track.Artists[0].Name
		}
		confidence := calculateConfidence(wantTokens, strings.Fields(strings.ToLower(track.Name+" "+artistName)))
		if best == nil || confidence > bestConfidence {
			best = track
			bestConfidence = confidence
		}
	}

	if best == nil || bestConfidence < MinConfidence {
		return nil, nil
	}

	return &queue.SourceRef{
		TrackURI:   best.URI,
		Confidence: bestConfidence,
	}, nil
}

// SearchCandidate represents a search result ready for the client
type SearchCandidate struct {
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	Source     string `json:"source"` // "spotify"|"deezer"
	SpotifyURI string `json:"spotifyUri,omitempty"`
	ISRC       string `json:"isrc"`
	DurationMs int    `json:"durationMs"`
	ArtworkURL string `json:"artworkUrl"`
}

// SearchSpotify searches Spotify for tracks by query string and returns up to limit results.
// Returns an empty slice if not configured or no results found.
func SearchSpotify(ctx context.Context, query string, limit int) ([]SearchCandidate, error) {
	// Clamp limit to 1..10
	if limit < 1 {
		limit = 1
	}
	if limit > 10 {
		limit = 10
	}

	// Get access token
	token, err := spotifyauth.Token(ctx)
	if errors.Is(err, spotifyauth.ErrNotConfigured) {
		return []SearchCandidate{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get spotify token: %w", err)
	}

	// Search Spotify
	searchReq, err := http.NewRequestWithContext(ctx, "GET", spotifySearchURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create search request: %w", err)
	}

	q := searchReq.URL.Query()
	q.Set("q", query)
	q.Set("type", "track")
	q.Set("limit", fmt.Sprintf("%d", limit))
	searchReq.URL.RawQuery = q.Encode()

	searchReq.Header.Set("Authorization", fmt.Sprintf("Bearer %s", token))

	var result SpotifySearchResult
	if err := httpx.DoJSON(searchReq, &result); err != nil {
		return nil, fmt.Errorf("search request failed: %w", err)
	}

	candidates := make([]SearchCandidate, 0, len(result.Tracks.Items))
	for _, track := range result.Tracks.Items {
		artist := ""
		if len(track.Artists) > 0 {
			artist = track.Artists[0].Name
		}
		artwork := ""
		if len(track.Album.Images) > 0 {
			artwork = track.Album.Images[0].URL
		}

		candidates = append(candidates, SearchCandidate{
			Title:      track.Name,
			Artist:     artist,
			Source:     "spotify",
			SpotifyURI: track.URI,
			ISRC:       track.ExternalIDs.ISRC,
			DurationMs: track.DurationMs,
			ArtworkURL: artwork,
		})
	}

	return candidates, nil
}

// SearchDeezer searches Deezer for tracks by query string and returns up to limit results.
// No authentication required; Deezer API is public.
// Returns empty slice on zero results.
func SearchDeezer(ctx context.Context, query string, limit int) ([]SearchCandidate, error) {
	// Clamp limit to 1..10
	if limit < 1 {
		limit = 1
	}
	if limit > 10 {
		limit = 10
	}

	searchReq, err := http.NewRequestWithContext(ctx, "GET", deezerSearchURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	q := searchReq.URL.Query()
	q.Set("q", query)
	q.Set("limit", fmt.Sprintf("%d", limit))
	searchReq.URL.RawQuery = q.Encode()

	var result struct {
		Data []struct {
			Title    string `json:"title"`
			Duration int    `json:"duration"` // In seconds
			Artist   struct {
				Name string `json:"name"`
			} `json:"artist"`
			Album struct {
				CoverMedium string `json:"cover_medium"`
			} `json:"album"`
		} `json:"data"`
	}
	if err := httpx.DoJSON(searchReq, &result); err != nil {
		return nil, fmt.Errorf("search request failed: %w", err)
	}

	candidates := make([]SearchCandidate, 0, len(result.Data))
	for _, track := range result.Data {
		candidates = append(candidates, SearchCandidate{
			Title:      track.Title,
			Artist:     track.Artist.Name,
			Source:     "deezer",
			SpotifyURI: "",
			ISRC:       "", // Deezer basic search does not include ISRC
			DurationMs: track.Duration * 1000,
			ArtworkURL: track.Album.CoverMedium,
		})
	}

	return candidates, nil
}

// SearchAll aggregates search results from available sources: Deezer (always)
// and Spotify (if configured). Each source is queried with a short timeout;
// timeouts or errors are logged and skipped. Results are deduplicated by ISRC
// when both sources have it, preferring results with SpotifyURI for playback.
// The pool is bounded by the per-source limits (each source is queried with
// limit); callers truncate after ranking so preferred-provider results are not
// discarded before they can be ranked first.
func SearchAll(ctx context.Context, query string, limit int) ([]SearchCandidate, error) {
	// Clamp limit
	if limit < 1 {
		limit = 1
	}
	if limit > 10 {
		limit = 10
	}

	// Collect results from all available sources concurrently
	// Use WaitGroup + goroutines (errgroup not strictly necessary for this use case)
	var wg sync.WaitGroup
	var mu sync.Mutex
	allCandidates := make([]SearchCandidate, 0)

	// Per-source timeout
	const sourceTimeout = 4 * time.Second

	// Deezer (always available, no config needed)
	wg.Add(1)
	go func() {
		defer wg.Done()
		ctx, cancel := context.WithTimeout(ctx, sourceTimeout)
		defer cancel()
		results, err := SearchDeezer(ctx, query, limit)
		if err != nil {
			// Log but don't fail the whole search
			slog.Warn("search_deezer_failed", "query", query, "err", err.Error())
			return
		}
		mu.Lock()
		allCandidates = append(allCandidates, results...)
		mu.Unlock()
	}()

	// Spotify (if configured)
	if spotifyauth.ClientID != "" && spotifyauth.ClientSecret != "" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(ctx, sourceTimeout)
			defer cancel()
			results, err := SearchSpotify(ctx, query, limit)
			if err != nil {
				slog.Warn("search_spotify_failed", "query", query, "err", err.Error())
				return
			}
			mu.Lock()
			allCandidates = append(allCandidates, results...)
			mu.Unlock()
		}()
	}

	wg.Wait()

	// Deduplicate by ISRC (when both results have ISRC) or by normalized title+artist
	// Prefer result with SpotifyURI when merging duplicates
	seen := make(map[string]int) // Key -> index in deduplicated list
	deduplicated := make([]SearchCandidate, 0)

	for _, c := range allCandidates {
		// Build dedup key: prefer ISRC if available, else normalized title+artist
		var key string
		if c.ISRC != "" {
			key = "isrc:" + c.ISRC
		} else {
			// Normalize: lowercase, pipe-separated
			key = "title:" + strings.ToLower(c.Title+"|"+c.Artist)
		}

		if idx, found := seen[key]; found {
			// Merge: prefer the one with SpotifyURI
			existing := &deduplicated[idx]
			if c.SpotifyURI != "" && existing.SpotifyURI == "" {
				// Merge c's SpotifyURI into existing
				existing.SpotifyURI = c.SpotifyURI
				existing.Source = c.Source // Update source to the one with SpotifyURI
			}
			// Also fill in missing ISRC/artwork from c if existing is missing them
			if existing.ISRC == "" && c.ISRC != "" {
				existing.ISRC = c.ISRC
			}
			if existing.ArtworkURL == "" && c.ArtworkURL != "" {
				existing.ArtworkURL = c.ArtworkURL
			}
		} else {
			// New entry
			seen[key] = len(deduplicated)
			deduplicated = append(deduplicated, c)
		}
	}

	// No cap here: the caller truncates after RankByProviders so that
	// playable-on-preferred-provider candidates survive to be ranked first.
	return deduplicated, nil
}

// providerAllowlist gates which provider names may influence ranking.
var providerAllowlist = map[string]bool{"spotify": true, "deezer": true, "apple": true}

// playableOn reports whether the candidate can be played via provider p.
// Spotify playback needs a URI, which dedup may have merged onto a Deezer-sourced
// entry, so the URI is the authoritative signal: a spotify-sourced candidate
// without one is not playable on Spotify.
func playableOn(c SearchCandidate, p string) bool {
	if p == "spotify" {
		return c.SpotifyURI != ""
	}
	return c.Source == p
}

// RankByProviders stable-partitions results so candidates playable on any of the
// caller's preferred providers come first. Within each group the input order is
// preserved. Unknown providers are ignored; empty prefer returns the input order.
func RankByProviders(results []SearchCandidate, prefer []string) []SearchCandidate {
	set := make(map[string]bool, len(prefer))
	for _, p := range prefer {
		p = strings.ToLower(strings.TrimSpace(p))
		if providerAllowlist[p] {
			set[p] = true
		}
	}
	if len(set) == 0 || len(results) < 2 {
		return results
	}

	preferred := make([]SearchCandidate, 0, len(results))
	rest := make([]SearchCandidate, 0, len(results))
	for _, c := range results {
		ok := false
		for p := range set {
			if playableOn(c, p) {
				ok = true
				break
			}
		}
		if ok {
			preferred = append(preferred, c)
		} else {
			rest = append(rest, c)
		}
	}
	return append(preferred, rest...)
}

// LastfmSimilarTrack represents a similar track from Last.fm API
type LastfmSimilarTrack struct {
	Name   string `json:"name"`
	Artist struct {
		Name string `json:"name"`
	} `json:"artist"`
}

// LastfmSimilarResponse wraps Last.fm similar tracks response
type LastfmSimilarResponse struct {
	SimilarTracks struct {
		Track []LastfmSimilarTrack `json:"track"`
	} `json:"similartracks"`
}

// SimilarTracks fetches tracks similar to the given track from Last.fm.
// Returns ErrNotConfigured if LASTFM_API_KEY env var is unset.
// Uses track.getSimilar endpoint with autocorrect enabled.
func SimilarTracks(ctx context.Context, artist, title string, limit int) ([]queue.TrackRef, error) {
	if lastfmAPIKey == "" {
		return nil, ErrNotConfigured
	}

	// Clamp limit
	if limit < 1 {
		limit = 1
	}
	if limit > 20 {
		limit = 20
	}

	params := url.Values{}
	params.Set("method", "track.getSimilar")
	params.Set("artist", artist)
	params.Set("track", title)
	params.Set("api_key", lastfmAPIKey)
	params.Set("format", "json")
	params.Set("limit", fmt.Sprintf("%d", limit))
	params.Set("autocorrect", "1")

	req, err := http.NewRequestWithContext(ctx, "GET", lastfmURL+"?"+params.Encode(), nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("User-Agent", "cojam/0.1")

	var result LastfmSimilarResponse
	if err := httpx.DoJSON(req, &result); err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}

	// Map Last.fm results to TrackRef (no source; enrichment will resolve playback)
	tracks := make([]queue.TrackRef, 0, len(result.SimilarTracks.Track))
	for _, t := range result.SimilarTracks.Track {
		if t.Name == "" || t.Artist.Name == "" {
			continue
		}
		tracks = append(tracks, queue.TrackRef{
			Title:  t.Name,
			Artist: t.Artist.Name,
		})
	}

	return tracks, nil
}

// LastfmEnrich represents enrichment data from Last.fm (playcount, listeners, top tags)
type LastfmEnrich struct {
	Playcount int      `json:"playcount,omitempty"`
	Listeners int      `json:"listeners,omitempty"`
	Tags      []string `json:"tags"`
	Source    string   `json:"source"` // Always "lastfm"
}

// lastfmTrackInfoResponse wraps Last.fm track.getInfo response
type lastfmTrackInfoResponse struct {
	Track struct {
		Name      string `json:"name"`
		Artist    string `json:"artist"`
		Playcount string `json:"playcount"` // String in Last.fm API
		Listeners string `json:"listeners"`
		Tags      struct {
			Tag []struct {
				Name string `json:"name"`
			} `json:"tag"`
		} `json:"tags"`
	} `json:"track"`
}

// FetchLastfmEnrichment queries Last.fm for enrichment data about a track
// (playcount, listeners, and top tags). Returns ErrNotConfigured when
// LASTFM_API_KEY is unset. Returns graceful empty enrichment on network error.
func FetchLastfmEnrichment(ctx context.Context, artist, title string) (*LastfmEnrich, error) {
	if lastfmAPIKey == "" {
		return nil, ErrNotConfigured
	}

	// Default graceful empty result
	result := &LastfmEnrich{
		Tags:   []string{},
		Source: "lastfm",
	}

	// Build request to track.getInfo
	params := url.Values{}
	params.Set("method", "track.getInfo")
	params.Set("artist", artist)
	params.Set("track", title)
	params.Set("api_key", lastfmAPIKey)
	params.Set("format", "json")
	params.Set("autocorrect", "1")

	req, err := http.NewRequestWithContext(ctx, "GET", lastfmURL+"?"+params.Encode(), nil)
	if err != nil {
		// Graceful return on request creation error
		return result, nil
	}

	req.Header.Set("User-Agent", "cojam/0.1 (https://github.com/LucasSantana-Dev/cojam)")

	var resp lastfmTrackInfoResponse
	if err := httpx.DoJSON(req, &resp); err != nil {
		// Graceful return on network/parsing error
		return result, nil
	}

	// Extract playcount and listeners (Last.fm returns them as strings)
	if resp.Track.Playcount != "" {
		if pc, parseErr := fmt.Sscanf(resp.Track.Playcount, "%d", &result.Playcount); parseErr == nil {
			// Set only if successfully parsed
			_ = pc
		}
	}
	if resp.Track.Listeners != "" {
		if ls, parseErr := fmt.Sscanf(resp.Track.Listeners, "%d", &result.Listeners); parseErr == nil {
			// Set only if successfully parsed
			_ = ls
		}
	}

	// Extract top tags
	if resp.Track.Tags.Tag != nil {
		tags := make([]string, 0, len(resp.Track.Tags.Tag))
		for _, t := range resp.Track.Tags.Tag {
			if t.Name != "" {
				tags = append(tags, t.Name)
			}
		}
		result.Tags = tags
	}

	return result, nil
}
