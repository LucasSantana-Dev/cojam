package playlist

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

func TestParsePlaylistURL(t *testing.T) {
	tests := []struct {
		name      string
		url       string
		wantSrc   string
		wantID    string
		wantOK    bool
	}{
		{
			name:    "deezer url",
			url:     "https://www.deezer.com/en/playlist/1313621735",
			wantSrc: "deezer",
			wantID:  "1313621735",
			wantOK:  true,
		},
		{
			name:    "deezer api url",
			url:     "https://api.deezer.com/playlist/1313621735",
			wantSrc: "deezer",
			wantID:  "1313621735",
			wantOK:  true,
		},
		{
			name:    "spotify url",
			url:     "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
			wantSrc: "spotify",
			wantID:  "37i9dQZF1DXcBWIGoYBM5M",
			wantOK:  true,
		},
		{
			name:    "spotify uri",
			url:     "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
			wantSrc: "spotify",
			wantID:  "37i9dQZF1DXcBWIGoYBM5M",
			wantOK:  true,
		},
		{
			name:    "youtube url",
			url:     "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
			wantSrc: "youtube",
			wantID:  "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
			wantOK:  true,
		},
		{
			name:    "youtube watch url with list",
			url:     "https://www.youtube.com/watch?v=someVideo&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
			wantSrc: "youtube",
			wantID:  "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
			wantOK:  true,
		},
		{
			name:    "empty url",
			url:     "",
			wantSrc: "",
			wantID:  "",
			wantOK:  false,
		},
		{
			name:    "invalid url",
			url:     "not a url at all",
			wantSrc: "",
			wantID:  "",
			wantOK:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			src, id, ok := ParsePlaylistURL(tt.url)
			if ok != tt.wantOK || src != tt.wantSrc || id != tt.wantID {
				t.Errorf("ParsePlaylistURL(%q) = (%q, %q, %v), want (%q, %q, %v)",
					tt.url, src, id, ok, tt.wantSrc, tt.wantID, tt.wantOK)
			}
		})
	}
}

func TestFetchDeezerPlaylist(t *testing.T) {
	// Mock Deezer API
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"tracks": map[string]interface{}{
				"data": []map[string]interface{}{
					{
						"title":    "Song 1",
						"duration": 180,
						"artist": map[string]string{
							"name": "Artist 1",
						},
					},
					{
						"title":    "Song 2",
						"duration": 240,
						"artist": map[string]string{
							"name": "Artist 2",
						},
					},
				},
			},
		})
	}))
	defer server.Close()

	// Override the URL for testing
	deezerPlaylistURL = server.URL

	ctx := context.Background()
	tracks, err := FetchDeezerPlaylist(ctx, "123")
	if err != nil {
		t.Fatalf("FetchDeezerPlaylist: %v", err)
	}

	if len(tracks) != 2 {
		t.Fatalf("expected 2 tracks, got %d", len(tracks))
	}

	if tracks[0].Title != "Song 1" || tracks[0].Artist != "Artist 1" {
		t.Errorf("track 0: got %q/%q, want Song 1/Artist 1", tracks[0].Title, tracks[0].Artist)
	}
	if tracks[0].DurationMs != 180000 {
		t.Errorf("track 0 duration: got %d, want 180000", tracks[0].DurationMs)
	}

	if tracks[1].Title != "Song 2" {
		t.Errorf("track 1: got %q, want Song 2", tracks[1].Title)
	}
}

func TestFetchDeezerPlaylist_HTTP404(t *testing.T) {
	oldURL := deezerPlaylistURL
	defer func() { deezerPlaylistURL = oldURL }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":"not found"}`))
	}))
	defer server.Close()

	deezerPlaylistURL = server.URL

	_, err := FetchDeezerPlaylist(context.Background(), "invalid")
	if err == nil {
		t.Errorf("expected error on 404, got nil")
	}
}

func TestFetchDeezerPlaylist_HTTP500(t *testing.T) {
	oldURL := deezerPlaylistURL
	defer func() { deezerPlaylistURL = oldURL }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"server error"}`))
	}))
	defer server.Close()

	deezerPlaylistURL = server.URL

	_, err := FetchDeezerPlaylist(context.Background(), "123")
	if err == nil {
		t.Errorf("expected error on 500, got nil")
	}
}

func TestFetchDeezerPlaylist_MalformedJSON(t *testing.T) {
	oldURL := deezerPlaylistURL
	defer func() { deezerPlaylistURL = oldURL }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{invalid json`))
	}))
	defer server.Close()

	deezerPlaylistURL = server.URL

	_, err := FetchDeezerPlaylist(context.Background(), "123")
	if err == nil {
		t.Errorf("expected error on malformed JSON, got nil")
	}
}

func TestFetchDeezerPlaylist_EmptyPlaylist(t *testing.T) {
	oldURL := deezerPlaylistURL
	defer func() { deezerPlaylistURL = oldURL }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"tracks": map[string]interface{}{
				"data": []interface{}{},
			},
		})
	}))
	defer server.Close()

	deezerPlaylistURL = server.URL

	tracks, err := FetchDeezerPlaylist(context.Background(), "123")
	if err != nil {
		t.Fatalf("empty playlist should not error: %v", err)
	}

	if len(tracks) != 0 {
		t.Fatalf("expected empty slice for empty playlist, got %d", len(tracks))
	}
}

func TestFetchSpotifyPlaylistNotConfigured(t *testing.T) {
	// Clear Spotify credentials
	t.Setenv("SPOTIFY_CLIENT_ID", "")
	t.Setenv("SPOTIFY_CLIENT_SECRET", "")

	ctx := context.Background()
	_, err := FetchSpotifyPlaylist(ctx, "playlistID")
	if err == nil {
		t.Errorf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "not configured") {
		t.Errorf("expected 'not configured' in error, got %v", err)
	}
}

func TestFetchSpotifyPlaylist_HTTP404(t *testing.T) {
	oldURL := spotifyPlaylistURL
	defer func() { spotifyPlaylistURL = oldURL }()

	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"access_token": "test-token",
			"expires_in":   "3600",
		})
	}))
	defer tokenSrv.Close()

	playlistSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":{"message":"Not Found"}}`))
	}))
	defer playlistSrv.Close()

	spotifyPlaylistURL = playlistSrv.URL
	t.Setenv("SPOTIFY_CLIENT_ID", "id")
	t.Setenv("SPOTIFY_CLIENT_SECRET", "secret")

	_, err := FetchSpotifyPlaylist(context.Background(), "invalid")
	if err == nil {
		t.Errorf("expected error on 404, got nil")
	}
}

func TestFetchSpotifyPlaylist_HTTP500(t *testing.T) {
	oldURL := spotifyPlaylistURL
	defer func() { spotifyPlaylistURL = oldURL }()

	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"access_token": "test-token",
			"expires_in":   "3600",
		})
	}))
	defer tokenSrv.Close()

	playlistSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":{"message":"Server Error"}}`))
	}))
	defer playlistSrv.Close()

	spotifyPlaylistURL = playlistSrv.URL
	t.Setenv("SPOTIFY_CLIENT_ID", "id")
	t.Setenv("SPOTIFY_CLIENT_SECRET", "secret")

	_, err := FetchSpotifyPlaylist(context.Background(), "123")
	if err == nil {
		t.Errorf("expected error on 500, got nil")
	}
}

func TestFetchSpotifyPlaylist_MalformedJSON(t *testing.T) {
	oldURL := spotifyPlaylistURL
	defer func() { spotifyPlaylistURL = oldURL }()

	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"access_token": "test-token",
			"expires_in":   "3600",
		})
	}))
	defer tokenSrv.Close()

	playlistSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{invalid json`))
	}))
	defer playlistSrv.Close()

	spotifyPlaylistURL = playlistSrv.URL
	t.Setenv("SPOTIFY_CLIENT_ID", "id")
	t.Setenv("SPOTIFY_CLIENT_SECRET", "secret")

	_, err := FetchSpotifyPlaylist(context.Background(), "123")
	if err == nil {
		t.Errorf("expected error on malformed JSON, got nil")
	}
}

func TestFetchYouTubePlaylist(t *testing.T) {
	// Mock YouTube API
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"items": []map[string]interface{}{
				{
					"snippet": map[string]string{
						"title":                     "YouTube Video 1",
						"videoOwnerChannelTitle":    "YouTube Channel 1",
					},
					"contentDetails": map[string]string{
						"videoId": "dQw4w9WgXcQ",
					},
				},
			},
		})
	}))
	defer server.Close()

	// Override URL for testing
	youtubePlaylistURL = server.URL
	t.Setenv("YOUTUBE_API_KEY", "test-key")

	ctx := context.Background()
	tracks, err := FetchYouTubePlaylist(ctx, "playlistID")
	if err != nil {
		t.Fatalf("FetchYouTubePlaylist: %v", err)
	}

	if len(tracks) != 1 {
		t.Fatalf("expected 1 track, got %d", len(tracks))
	}

	track := tracks[0]
	if track.Title != "YouTube Video 1" {
		t.Errorf("title: got %q, want YouTube Video 1", track.Title)
	}
	if track.Sources.YouTube == nil || track.Sources.YouTube.VideoID != "dQw4w9WgXcQ" {
		t.Errorf("youtube source not set correctly")
	}
}

func TestFetchYouTubePlaylistNotConfigured(t *testing.T) {
	// Clear YouTube API key
	t.Setenv("YOUTUBE_API_KEY", "")

	ctx := context.Background()
	_, err := FetchYouTubePlaylist(ctx, "playlistID")
	if err != ErrNotConfigured {
		t.Errorf("expected ErrNotConfigured, got %v", err)
	}
}

func TestFetchYouTubePlaylist_HTTP404(t *testing.T) {
	oldURL := youtubePlaylistURL
	defer func() { youtubePlaylistURL = oldURL }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":{"message":"Not Found"}}`))
	}))
	defer server.Close()

	youtubePlaylistURL = server.URL
	t.Setenv("YOUTUBE_API_KEY", "test-key")

	_, err := FetchYouTubePlaylist(context.Background(), "invalid")
	if err == nil {
		t.Errorf("expected error on 404, got nil")
	}
}

func TestFetchYouTubePlaylist_HTTP500(t *testing.T) {
	oldURL := youtubePlaylistURL
	defer func() { youtubePlaylistURL = oldURL }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":{"message":"Server Error"}}`))
	}))
	defer server.Close()

	youtubePlaylistURL = server.URL
	t.Setenv("YOUTUBE_API_KEY", "test-key")

	_, err := FetchYouTubePlaylist(context.Background(), "PLxyz")
	if err == nil {
		t.Errorf("expected error on 500, got nil")
	}
}

func TestFetchYouTubePlaylist_MalformedJSON(t *testing.T) {
	oldURL := youtubePlaylistURL
	defer func() { youtubePlaylistURL = oldURL }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{invalid json`))
	}))
	defer server.Close()

	youtubePlaylistURL = server.URL
	t.Setenv("YOUTUBE_API_KEY", "test-key")

	_, err := FetchYouTubePlaylist(context.Background(), "PLxyz")
	if err == nil {
		t.Errorf("expected error on malformed JSON, got nil")
	}
}

func TestFetchYouTubePlaylist_EmptyPlaylist(t *testing.T) {
	oldURL := youtubePlaylistURL
	defer func() { youtubePlaylistURL = oldURL }()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"items": []interface{}{},
		})
	}))
	defer server.Close()

	youtubePlaylistURL = server.URL
	t.Setenv("YOUTUBE_API_KEY", "test-key")

	tracks, err := FetchYouTubePlaylist(context.Background(), "PLxyz")
	if err != nil {
		t.Fatalf("empty playlist should not error: %v", err)
	}

	if len(tracks) != 0 {
		t.Fatalf("expected empty slice for empty playlist, got %d", len(tracks))
	}
}

func TestFetchPlaylist(t *testing.T) {
	// Mock Deezer API
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"tracks": map[string]interface{}{
				"data": []map[string]interface{}{
					{
						"title":    "Test Song",
						"duration": 200,
						"artist": map[string]string{
							"name": "Test Artist",
						},
					},
				},
			},
		})
	}))
	defer server.Close()

	deezerPlaylistURL = server.URL

	ctx := context.Background()
	url := "https://www.deezer.com/en/playlist/1313621735"
	tracks, err := FetchPlaylist(ctx, url)
	if err != nil {
		t.Fatalf("FetchPlaylist: %v", err)
	}

	if len(tracks) != 1 {
		t.Fatalf("expected 1 track, got %d", len(tracks))
	}
	if tracks[0].Title != "Test Song" {
		t.Errorf("title: got %q, want Test Song", tracks[0].Title)
	}
}

func TestFetchPlaylistInvalidURL(t *testing.T) {
	ctx := context.Background()
	_, err := FetchPlaylist(ctx, "not a valid url")
	if err == nil {
		t.Fatalf("expected error for invalid URL")
	}
}

// Verify TrackRef can be marshaled/unmarshaled correctly
func TestTrackRefSerialization(t *testing.T) {
	track := queue.TrackRef{
		Title:      "Test",
		Artist:     "Artist",
		DurationMs: 180000,
		Sources: queue.Sources{
			YouTube: &queue.SourceRef{
				VideoID:    "testVid",
				Confidence: 1.0,
			},
		},
		AddedBy: "test-user",
	}

	data, err := json.Marshal(track)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded queue.TrackRef
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.Title != track.Title || decoded.Artist != track.Artist {
		t.Errorf("serialization failed: got %q/%q, want %q/%q",
			decoded.Title, decoded.Artist, track.Title, track.Artist)
	}
}
