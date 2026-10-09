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
	req, err := http.NewRequestWithContext(httpx.WithOp(ctx, "playlist"), "GET", url, nil)
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
		return nil, requestError(err)
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

// requestError strips the request URL from transport errors: *url.Error embeds
// it, and the YouTube URL carries key=<YOUTUBE_API_KEY>. Callers may show or
// log the result.
func requestError(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return fmt.Errorf("request failed: %w", ue.Err)
	}
	return fmt.Errorf("request failed: %w", err)
}

// MaxTracks bounds one playlist import (mirrors the hub's maxImportTracks so a
// huge playlist neither blows the websocket frame nor pages forever).
const MaxTracks = 200

var (
	// ErrSpotifyConnectRequired: Spotify refused the app-level (client
	// credentials) read and the caller has no connected Spotify account.
	ErrSpotifyConnectRequired = errors.New("spotify playlist needs a connected account")
	// ErrSpotifyNotOwner: the caller's own token was refused, which Spotify
	// does for playlists the user neither owns nor collaborates on.
	ErrSpotifyNotOwner = errors.New("spotify playlist is not owned by the connected account")
	// ErrSpotifyEditorial: Spotify-made playlists (37i9... ids) are never
	// readable by development-mode apps; a 404 on an existing id means the same.
	ErrSpotifyEditorial = errors.New("spotify editorial playlist cannot be read")
)

// UserTokenFunc returns a Spotify user-authorized access token for the
// importing caller, or an error when there is none (not connected, grant
// revoked). Any error makes the fetch fall back to client credentials.
type UserTokenFunc func(ctx context.Context) (string, error)

type userTokenKey struct{}

// WithUserToken attaches the caller's token source to ctx, so the single-URL
// FetchPlaylist signature stays unchanged.
func WithUserToken(ctx context.Context, fn UserTokenFunc) context.Context {
	return context.WithValue(ctx, userTokenKey{}, fn)
}

// UserTokenFrom returns the caller's token source attached by WithUserToken.
func UserTokenFrom(ctx context.Context) (UserTokenFunc, bool) {
	fn, ok := ctx.Value(userTokenKey{}).(UserTokenFunc)
	return fn, ok && fn != nil
}

func isEditorialSpotifyID(id string) bool {
	return strings.HasPrefix(id, "37i9")
}

// spotifyPlaylistItem accepts both response shapes: the Feb 2026 API renamed
// items[].track to items[].item.
type spotifyPlaylistItem struct {
	Item  *spotifyTrack `json:"item"`
	Track *spotifyTrack `json:"track"`
}

type spotifyTrack struct {
	Name       string `json:"name"`
	URI        string `json:"uri"`
	DurationMs int    `json:"duration_ms"`
	Artists    []struct {
		Name string `json:"name"`
	} `json:"artists"`
	ExternalIDs struct {
		ISRC string `json:"isrc"`
	} `json:"external_ids"`
	Album struct {
		Images []struct {
			URL string `json:"url"`
		} `json:"images"`
	} `json:"album"`
}

// FetchSpotifyPlaylist fetches tracks from a Spotify playlist. When ctx carries
// a user token source (WithUserToken) and it yields a token, the playlist is
// read with the caller's own authorization, the only kind Spotify still allows
// for development-mode apps. Otherwise it falls back to client credentials
// (SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET), which Spotify mostly refuses.
func FetchSpotifyPlaylist(ctx context.Context, playlistID string) ([]queue.TrackRef, error) {
	if playlistID == "" {
		return nil, errors.New("empty playlist ID")
	}
	if isEditorialSpotifyID(playlistID) {
		return nil, ErrSpotifyEditorial
	}

	var token string
	asUser := false
	if fn, ok := UserTokenFrom(ctx); ok {
		if t, err := fn(ctx); err == nil && t != "" {
			token, asUser = t, true
		}
	}
	if !asUser {
		t, err := spotifyauth.Token(ctx)
		if errors.Is(err, spotifyauth.ErrNotConfigured) {
			return nil, ErrNotConfigured
		}
		if err != nil {
			return nil, fmt.Errorf("failed to get spotify token: %w", err)
		}
		token = t
	}

	// /tracks was removed in the Feb 2026 API; /items is the replacement.
	next := fmt.Sprintf("%s/%s/items?limit=100", spotifyPlaylistURL, url.PathEscape(playlistID))
	if asUser {
		next += "&market=from_token"
	}
	tracks := make([]queue.TrackRef, 0, 100)
	for page := 0; next != "" && len(tracks) < MaxTracks && page < 10; page++ {
		req, err := http.NewRequestWithContext(httpx.WithOp(ctx, "playlist"), "GET", next, nil)
		if err != nil {
			return nil, fmt.Errorf("failed to create request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+token)

		var result struct {
			Items []spotifyPlaylistItem `json:"items"`
			Next  string                `json:"next"`
		}
		if err := httpx.DoJSON(req, &result); err != nil {
			var se *httpx.StatusError
			if errors.As(err, &se) {
				switch {
				case se.Code == http.StatusNotFound:
					if asUser {
						return nil, ErrSpotifyEditorial
					}
					return nil, ErrSpotifyConnectRequired
				case se.Code == http.StatusForbidden || se.Code == http.StatusUnauthorized:
					if asUser {
						return nil, ErrSpotifyNotOwner
					}
					return nil, ErrSpotifyConnectRequired
				}
			}
			return nil, requestError(err)
		}

		for _, it := range result.Items {
			t := it.Item
			if t == nil {
				t = it.Track
			}
			if t == nil || t.Name == "" || t.URI == "" {
				continue // local files and removed tracks never resolve
			}
			artist := ""
			if len(t.Artists) > 0 {
				artist = t.Artists[0].Name
			}
			ref := queue.TrackRef{
				Title:      t.Name,
				Artist:     artist,
				DurationMs: int64(t.DurationMs),
				ISRC:       t.ExternalIDs.ISRC,
				Sources: queue.Sources{
					Spotify: &queue.SourceRef{TrackURI: t.URI, Confidence: 1.0},
				},
			}
			if len(t.Album.Images) > 0 {
				ref.ArtworkURL = t.Album.Images[0].URL
			}
			tracks = append(tracks, ref)
			if len(tracks) >= MaxTracks {
				break
			}
		}
		// The credential only ever goes to the Spotify API.
		if !strings.HasPrefix(result.Next, spotifyPlaylistURL+"/") {
			break
		}
		next = result.Next
	}

	return tracks, nil
}

// FetchYouTubePlaylist fetches tracks from a YouTube playlist, 50 per page,
// bounded by MaxTracks. Requires YOUTUBE_API_KEY.
func FetchYouTubePlaylist(ctx context.Context, playlistID string) ([]queue.TrackRef, error) {
	if playlistID == "" {
		return nil, errors.New("empty playlist ID")
	}

	apiKey := os.Getenv("YOUTUBE_API_KEY")
	if apiKey == "" {
		return nil, ErrNotConfigured
	}

	tracks := make([]queue.TrackRef, 0, 50)
	pageToken := ""
	for page := 0; page < 10 && len(tracks) < MaxTracks; page++ {
		q := url.Values{}
		q.Set("part", "snippet,contentDetails")
		q.Set("maxResults", "50")
		q.Set("playlistId", playlistID)
		q.Set("key", apiKey)
		if pageToken != "" {
			q.Set("pageToken", pageToken)
		}

		req, err := http.NewRequestWithContext(httpx.WithOp(ctx, "playlist"), "GET", fmt.Sprintf("%s?%s", youtubePlaylistURL, q.Encode()), nil)
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
			NextPageToken string `json:"nextPageToken"`
		}
		if err := httpx.DoJSON(req, &result); err != nil {
			return nil, requestError(err)
		}

		for _, item := range result.Items {
			tracks = append(tracks, queue.TrackRef{
				Title:  item.Snippet.Title,
				Artist: item.Snippet.VideoOwnerChannelTitle,
				Sources: queue.Sources{
					YouTube: &queue.SourceRef{VideoID: item.ContentDetails.VideoID, Confidence: 1.0},
				},
			})
			if len(tracks) >= MaxTracks {
				break
			}
		}
		if result.NextPageToken == "" {
			break
		}
		pageToken = result.NextPageToken
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
