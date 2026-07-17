package playlist

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/LucasSantana-Dev/cojam/server/internal/httpx"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/spotifyauth"
)

var (
	ErrNotConfigured = errors.New("service not configured")

	// Package-level URLs for testability (can be overridden in tests)
	deezerPlaylistURL  = "https://api.deezer.com/playlist"
	spotifyPlaylistURL = "https://api.spotify.com/v1/playlists"
	youtubePlaylistURL = "https://www.googleapis.com/youtube/v3/playlistItems"
)

// ParsePlaylistURL parses a playlist URL and returns the source and playlist ID.
// Recognized formats:
// - Deezer: deezer.com/.../playlist/<id> or api.deezer.com/playlist/<id>
// - Spotify: open.spotify.com/playlist/<id> or spotify:playlist:<id>
// - YouTube: youtube.com/playlist?list=<id> or watch?...&list=<id>
// hostIs reports whether host equals domain or is a subdomain of it, so a
// look-alike host like "deezer.com.attacker.example" does not match.
func hostIs(host, domain string) bool {
	host = strings.ToLower(host)
	return host == domain || strings.HasSuffix(host, "."+domain)
}

func ParsePlaylistURL(raw string) (source string, id string, ok bool) {
	if raw = strings.TrimSpace(raw); raw == "" {
		return "", "", false
	}

	// Spotify URI format: spotify:playlist:<id>
	if strings.HasPrefix(raw, "spotify:playlist:") {
		id = strings.TrimPrefix(raw, "spotify:playlist:")
		if id != "" {
			return "spotify", id, true
		}
	}

	// Parse URL
	u, err := url.Parse(raw)
	if err != nil {
		return "", "", false
	}

	// Deezer
	if hostIs(u.Hostname(), "deezer.com") {
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		for i, part := range parts {
			if part == "playlist" && i+1 < len(parts) {
				id = parts[i+1]
				if id != "" {
					return "deezer", id, true
				}
			}
		}
	}

	// Spotify (open.spotify.com/playlist/<id>)
	if hostIs(u.Hostname(), "spotify.com") {
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		for i, part := range parts {
			if part == "playlist" && i+1 < len(parts) {
				id = parts[i+1]
				if id != "" {
					return "spotify", id, true
				}
			}
		}
	}

	// YouTube (list=<id> query param)
	if hostIs(u.Hostname(), "youtube.com") || hostIs(u.Hostname(), "youtu.be") {
		id = u.Query().Get("list")
		if id != "" {
			return "youtube", id, true
		}
	}

	return "", "", false
}

// FetchDeezerPlaylist fetches tracks from a Deezer playlist.
// No authentication required; returns up to ~100 tracks.
func FetchDeezerPlaylist(ctx context.Context, playlistID string) ([]queue.TrackRef, error) {
	if playlistID == "" {
		return nil, errors.New("empty playlist ID")
	}

	url := fmt.Sprintf("%s/%s", deezerPlaylistURL, playlistID)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	var result struct {
		Tracks struct {
			Data []struct {
				Title    string `json:"title"`
				Duration int    `json:"duration"` // In seconds
				Artist   struct {
					Name string `json:"name"`
				} `json:"artist"`
			} `json:"data"`
		} `json:"tracks"`
	}
	if err := httpx.DoJSON(req, &result); err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}

	tracks := make([]queue.TrackRef, 0, len(result.Tracks.Data))
	for _, track := range result.Tracks.Data {
		tracks = append(tracks, queue.TrackRef{
			Title:      track.Title,
			Artist:     track.Artist.Name,
			DurationMs: int64(track.Duration) * 1000,
			Sources:    queue.Sources{},
		})
	}

	return tracks, nil
}

// FetchSpotifyPlaylist fetches tracks from a Spotify playlist.
// Requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.
func FetchSpotifyPlaylist(ctx context.Context, playlistID string) ([]queue.TrackRef, error) {
	if playlistID == "" {
		return nil, errors.New("empty playlist ID")
	}

	token, err := spotifyauth.Token(ctx)
	if errors.Is(err, spotifyauth.ErrNotConfigured) {
		return nil, ErrNotConfigured
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get spotify token: %w", err)
	}

	url := fmt.Sprintf("%s/%s/tracks?limit=100", spotifyPlaylistURL, playlistID)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", token))

	var result struct {
		Items []struct {
			Track struct {
				Name       string `json:"name"`
				URI        string `json:"uri"`
				DurationMs int    `json:"duration_ms"`
				Artists    []struct {
					Name string `json:"name"`
				} `json:"artists"`
				ExternalIDs struct {
					ISRC string `json:"isrc"`
				} `json:"external_ids"`
			} `json:"track"`
		} `json:"items"`
	}
	if err := httpx.DoJSON(req, &result); err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}

	tracks := make([]queue.TrackRef, 0, len(result.Items))
	for _, item := range result.Items {
		artist := ""
		if len(item.Track.Artists) > 0 {
			artist = item.Track.Artists[0].Name
		}
		tracks = append(tracks, queue.TrackRef{
			Title:      item.Track.Name,
			Artist:     artist,
			DurationMs: int64(item.Track.DurationMs),
			ISRC:       item.Track.ExternalIDs.ISRC,
			Sources: queue.Sources{
				Spotify: &queue.SourceRef{
					TrackURI:   item.Track.URI,
					Confidence: 1.0,
				},
			},
		})
	}

	return tracks, nil
}

// FetchYouTubePlaylist fetches tracks from a YouTube playlist.
// Requires YOUTUBE_API_KEY environment variable.
func FetchYouTubePlaylist(ctx context.Context, playlistID string) ([]queue.TrackRef, error) {
	if playlistID == "" {
		return nil, errors.New("empty playlist ID")
	}

	apiKey := os.Getenv("YOUTUBE_API_KEY")
	if apiKey == "" {
		return nil, ErrNotConfigured
	}

	q := url.Values{}
	q.Set("part", "snippet,contentDetails")
	q.Set("maxResults", "50")
	q.Set("playlistId", playlistID)
	q.Set("key", apiKey)

	url := fmt.Sprintf("%s?%s", youtubePlaylistURL, q.Encode())
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	var result struct {
		Items []struct {
			Snippet struct {
				Title                  string `json:"title"`
				VideoOwnerChannelTitle string `json:"videoOwnerChannelTitle"`
			} `json:"snippet"`
			ContentDetails struct {
				VideoID string `json:"videoId"`
			} `json:"contentDetails"`
		} `json:"items"`
	}
	if err := httpx.DoJSON(req, &result); err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}

	tracks := make([]queue.TrackRef, 0, len(result.Items))
	for _, item := range result.Items {
		tracks = append(tracks, queue.TrackRef{
			Title:  item.Snippet.Title,
			Artist: item.Snippet.VideoOwnerChannelTitle,
			Sources: queue.Sources{
				YouTube: &queue.SourceRef{
					VideoID:    item.ContentDetails.VideoID,
					Confidence: 1.0,
				},
			},
		})
	}

	return tracks, nil
}

// FetchPlaylist parses a playlist URL and fetches its tracks from the appropriate source.
func FetchPlaylist(ctx context.Context, url string) ([]queue.TrackRef, error) {
	source, id, ok := ParsePlaylistURL(url)
	if !ok {
		return nil, errors.New("invalid playlist URL")
	}

	switch source {
	case "deezer":
		return FetchDeezerPlaylist(ctx, id)
	case "spotify":
		return FetchSpotifyPlaylist(ctx, id)
	case "youtube":
		return FetchYouTubePlaylist(ctx, id)
	default:
		return nil, fmt.Errorf("unsupported playlist source: %s", source)
	}
}
