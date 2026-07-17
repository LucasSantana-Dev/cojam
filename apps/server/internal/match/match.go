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
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/httpx"
	"github.com/LucasSantana-Dev/cojam/server/internal/hub"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/spotifyauth"
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

	var result YouTubeSearchResult
	if err := httpx.DoJSON(req, &result); err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
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

// Spotify matcher implementation

// Package-level vars for testability (can be overridden in tests)
var (
	// Spotify search URL (token is now in spotifyauth package)
	spotifySearchURL = "https://api.spotify.com/v1/search"

	// Deezer vars (no auth needed, public API)
	deezerSearchURL = "https://api.deezer.com/search"

	// Tidal vars
	tidalClientID     = os.Getenv("TIDAL_CLIENT_ID")
	tidalClientSecret = os.Getenv("TIDAL_CLIENT_SECRET")
	tidalTokenURL     = "https://auth.tidal.com/v1/oauth2/token"
	tidalSearchURL    = "https://openapi.tidal.com/v2/search"
	tidalCountryCode  = "US" // Default country code for search

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

var (
	tidalTokenCache = &tokenCacheEntry{}
)

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
	Source     string `json:"source"` // "spotify"|"deezer"|"tidal"
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

// tidalAccessToken fetches or returns a cached Tidal API token via client credentials flow
func tidalAccessToken(ctx context.Context) (string, error) {
	tidalTokenCache.mu.Lock()
	defer tidalTokenCache.mu.Unlock()

	// Return cached token if not expired
	if tidalTokenCache.token != "" && time.Now().Before(tidalTokenCache.expiresAt) {
		return tidalTokenCache.token, nil
	}

	// Fetch new token via client credentials
	req, err := http.NewRequestWithContext(ctx, "POST", tidalTokenURL,
		strings.NewReader("grant_type=client_credentials"))
	if err != nil {
		return "", fmt.Errorf("failed to create token request: %w", err)
	}

	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(tidalClientID, tidalClientSecret)

	resp, err := httpx.Client.Do(req)
	if err != nil {
		return "", fmt.Errorf("token request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("unexpected token status %d", resp.StatusCode)
	}

	var tokenResp struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		TokenType   string `json:"token_type"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, httpx.MaxResponseBytes)).Decode(&tokenResp); err != nil {
		return "", fmt.Errorf("failed to decode token response: %w", err)
	}

	tidalTokenCache.token = tokenResp.AccessToken
	tidalTokenCache.expiresAt = time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second)

	return tidalTokenCache.token, nil
}

// SearchTidal searches Tidal for tracks by query string and returns up to limit results.
// Requires TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET environment variables.
// Returns empty slice when unconfigured.
func SearchTidal(ctx context.Context, query string, limit int) ([]SearchCandidate, error) {
	// Check configuration
	if tidalClientID == "" || tidalClientSecret == "" {
		return []SearchCandidate{}, nil
	}

	// Clamp limit to 1..10
	if limit < 1 {
		limit = 1
	}
	if limit > 10 {
		limit = 10
	}

	// Get access token
	token, err := tidalAccessToken(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get tidal token: %w", err)
	}

	// Search Tidal
	searchReq, err := http.NewRequestWithContext(ctx, "GET", tidalSearchURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create search request: %w", err)
	}

	q := searchReq.URL.Query()
	q.Set("q", query)
	q.Set("type", "TRACK")
	q.Set("limit", fmt.Sprintf("%d", limit))
	q.Set("countryCode", tidalCountryCode)
	searchReq.URL.RawQuery = q.Encode()

	searchReq.Header.Set("Authorization", fmt.Sprintf("Bearer %s", token))

	var result struct {
		Data []struct {
			ID       string `json:"id"`
			Title    string `json:"title"`
			Duration int    `json:"duration"` // In seconds
			ISRC     string `json:"isrc"`
			Artists  []struct {
				Name string `json:"name"`
			} `json:"artists"`
			Album struct {
				Cover string `json:"cover"`
			} `json:"album"`
		} `json:"data"`
	}
	if err := httpx.DoJSON(searchReq, &result); err != nil {
		return nil, fmt.Errorf("search request failed: %w", err)
	}

	candidates := make([]SearchCandidate, 0, len(result.Data))
	for _, track := range result.Data {
		artist := ""
		if len(track.Artists) > 0 {
			artist = track.Artists[0].Name
		}

		candidates = append(candidates, SearchCandidate{
			Title:      track.Title,
			Artist:     artist,
			Source:     "tidal",
			SpotifyURI: "",
			ISRC:       track.ISRC,
			DurationMs: track.Duration * 1000,
			ArtworkURL: track.Album.Cover,
		})
	}

	return candidates, nil
}

// SearchAll aggregates search results from available sources: Deezer (always),
// Spotify (if configured), and Tidal (if configured). Each source is queried
// with a short timeout; timeouts or errors are logged and skipped.
// Results are deduplicated by ISRC when both sources have it, preferring
// results with SpotifyURI for playback. Final list is capped at limit.
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
			fmt.Fprintf(os.Stderr, "SearchDeezer error: %v\n", err)
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
				fmt.Fprintf(os.Stderr, "SearchSpotify error: %v\n", err)
				return
			}
			mu.Lock()
			allCandidates = append(allCandidates, results...)
			mu.Unlock()
		}()
	}

	// Tidal (if configured)
	if tidalClientID != "" && tidalClientSecret != "" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(ctx, sourceTimeout)
			defer cancel()
			results, err := SearchTidal(ctx, query, limit)
			if err != nil {
				fmt.Fprintf(os.Stderr, "SearchTidal error: %v\n", err)
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

	// Cap at limit
	if len(deduplicated) > limit {
		deduplicated = deduplicated[:limit]
	}

	return deduplicated, nil
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
