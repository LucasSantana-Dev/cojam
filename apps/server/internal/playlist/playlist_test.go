package playlist

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/spotifyauth"
)

func TestParsePlaylistURL(t *testing.T) {
	tests := []struct {
		name    string
		url     string
		wantSrc string
		wantID  string
		wantOK  bool
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
	oldID, oldSecret := spotifyauth.ClientID, spotifyauth.ClientSecret
	defer func() {
		spotifyauth.ClientID, spotifyauth.ClientSecret = oldID, oldSecret
		spotifyauth.ResetCache()
	}()

	// Clear Spotify credentials
	spotifyauth.ClientID = ""
	spotifyauth.ClientSecret = ""
	spotifyauth.ResetCache()

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
	oldID, oldSecret := spotifyauth.ClientID, spotifyauth.ClientSecret
	oldTokURL, oldClient := spotifyauth.TokenURL, spotifyauth.Client
	defer func() {
		spotifyPlaylistURL = oldURL
		spotifyauth.ClientID, spotifyauth.ClientSecret = oldID, oldSecret
		spotifyauth.TokenURL, spotifyauth.Client = oldTokURL, oldClient
		spotifyauth.ResetCache()
	}()

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
	spotifyauth.ClientID = "id"
	spotifyauth.ClientSecret = "secret"
	spotifyauth.TokenURL = tokenSrv.URL
	spotifyauth.Client = http.DefaultClient
	spotifyauth.ResetCache()

	_, err := FetchSpotifyPlaylist(context.Background(), "invalid")
	if err == nil {
		t.Errorf("expected error on 404, got nil")
	}
}

func TestFetchSpotifyPlaylist_HTTP500(t *testing.T) {
	oldURL := spotifyPlaylistURL
	oldID, oldSecret := spotifyauth.ClientID, spotifyauth.ClientSecret
	oldTokURL, oldClient := spotifyauth.TokenURL, spotifyauth.Client
	defer func() {
		spotifyPlaylistURL = oldURL
		spotifyauth.ClientID, spotifyauth.ClientSecret = oldID, oldSecret
		spotifyauth.TokenURL, spotifyauth.Client = oldTokURL, oldClient
		spotifyauth.ResetCache()
	}()

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
	spotifyauth.ClientID = "id"
	spotifyauth.ClientSecret = "secret"
	spotifyauth.TokenURL = tokenSrv.URL
	spotifyauth.Client = http.DefaultClient
	spotifyauth.ResetCache()

	_, err := FetchSpotifyPlaylist(context.Background(), "123")
	if err == nil {
		t.Errorf("expected error on 500, got nil")
	}
}

func TestFetchSpotifyPlaylist_MalformedJSON(t *testing.T) {
	oldURL := spotifyPlaylistURL
	oldID, oldSecret := spotifyauth.ClientID, spotifyauth.ClientSecret
	oldTokURL, oldClient := spotifyauth.TokenURL, spotifyauth.Client
	defer func() {
		spotifyPlaylistURL = oldURL
		spotifyauth.ClientID, spotifyauth.ClientSecret = oldID, oldSecret
		spotifyauth.TokenURL, spotifyauth.Client = oldTokURL, oldClient
		spotifyauth.ResetCache()
	}()

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
	spotifyauth.ClientID = "id"
	spotifyauth.ClientSecret = "secret"
	spotifyauth.TokenURL = tokenSrv.URL
	spotifyauth.Client = http.DefaultClient
	spotifyauth.ResetCache()

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
						"title":                  "YouTube Video 1",
						"videoOwnerChannelTitle": "YouTube Channel 1",
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

// --- Spotify user-token path, error mapping and bounds ---

type spotifyFake struct {
	playlist *httptest.Server
	tokens   *httptest.Server
	auths    []string
	paths    []string
	queries  []string
}

func authHeader(tok string) string { return "Bear" + "er " + tok }

// newSpotifyFake serves playlists via handle and a client-credentials token
// endpoint, and points the package and spotifyauth at them.
func newSpotifyFake(t *testing.T, handle func(w http.ResponseWriter, r *http.Request)) *spotifyFake {
	t.Helper()
	f := &spotifyFake{}
	f.playlist = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.auths = append(f.auths, r.Header.Get("Authorization"))
		f.paths = append(f.paths, r.URL.Path)
		f.queries = append(f.queries, r.URL.RawQuery)
		w.Header().Set("Content-Type", "application/json")
		handle(w, r)
	}))
	f.tokens = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"access_token": "app-token", "expires_in": 3600})
	}))
	oldURL, oldID, oldSecret := spotifyPlaylistURL, spotifyauth.ClientID, spotifyauth.ClientSecret
	oldTok, oldClient := spotifyauth.TokenURL, spotifyauth.Client
	spotifyPlaylistURL = f.playlist.URL + "/v1/playlists"
	spotifyauth.ClientID, spotifyauth.ClientSecret = "id", "secret"
	spotifyauth.TokenURL, spotifyauth.Client = f.tokens.URL, http.DefaultClient
	spotifyauth.ResetCache()
	t.Cleanup(func() {
		f.playlist.Close()
		f.tokens.Close()
		spotifyPlaylistURL = oldURL
		spotifyauth.ClientID, spotifyauth.ClientSecret = oldID, oldSecret
		spotifyauth.TokenURL, spotifyauth.Client = oldTok, oldClient
		spotifyauth.ResetCache()
	})
	return f
}

func itemsPage(n int, next string, field string) map[string]any {
	items := make([]map[string]any, 0, n)
	for i := 0; i < n; i++ {
		items = append(items, map[string]any{field: map[string]any{
			"name": "Song", "uri": "spotify:track:0123456789012345678901", "duration_ms": 1000,
			"artists": []map[string]string{{"name": "Artist"}},
		}})
	}
	return map[string]any{"items": items, "next": next}
}

func userCtx(token string, err error) context.Context {
	return WithUserToken(context.Background(), func(context.Context) (string, error) { return token, err })
}

func TestFetchSpotifyPlaylist_UsesUserTokenWhenPresent(t *testing.T) {
	f := newSpotifyFake(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(itemsPage(2, "", "item")) // Feb 2026 shape
	})
	tracks, err := FetchSpotifyPlaylist(userCtx("user-token", nil), "abc123")
	if err != nil || len(tracks) != 2 {
		t.Fatalf("got %d tracks, err %v", len(tracks), err)
	}
	if f.auths[0] != authHeader("user-token") {
		t.Fatal("expected the user token to be used")
	}
	if f.paths[0] != "/v1/playlists/abc123/items" || !strings.Contains(f.queries[0], "market=from_token") {
		t.Fatalf("unexpected request %s?%s", f.paths[0], f.queries[0])
	}
}

func TestFetchSpotifyPlaylist_FallsBackToClientCredentials(t *testing.T) {
	for name, ctx := range map[string]context.Context{
		"no source":        context.Background(),
		"not connected":    userCtx("", errors.New("reconnect required")),
		"empty user token": userCtx("", nil),
	} {
		t.Run(name, func(t *testing.T) {
			f := newSpotifyFake(t, func(w http.ResponseWriter, r *http.Request) {
				json.NewEncoder(w).Encode(itemsPage(1, "", "track")) // legacy shape still parses
			})
			tracks, err := FetchSpotifyPlaylist(ctx, "abc123")
			if err != nil || len(tracks) != 1 {
				t.Fatalf("got %d tracks, err %v", len(tracks), err)
			}
			if f.auths[0] != authHeader("app-token") {
				t.Fatal("expected client credentials")
			}
			if strings.Contains(f.queries[0], "market") {
				t.Fatalf("client credentials must not ask for from_token: %s", f.queries[0])
			}
		})
	}
}

func TestFetchSpotifyPlaylist_ErrorMapping(t *testing.T) {
	cases := []struct {
		name   string
		ctx    context.Context
		id     string
		status int
		want   error
	}{
		{"403 without user token", context.Background(), "abc", 403, ErrSpotifyConnectRequired},
		{"403 with user token", userCtx("u", nil), "abc", 403, ErrSpotifyNotOwner},
		{"404 with user token", userCtx("u", nil), "abc", 404, ErrSpotifyEditorial},
		{"404 without user token", context.Background(), "abc", 404, ErrSpotifyConnectRequired},
		{"37i9 id", userCtx("u", nil), "37i9dQZF1DXcBWIGoYBM5M", 200, ErrSpotifyEditorial},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newSpotifyFake(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
			})
			_, err := FetchSpotifyPlaylist(tc.ctx, tc.id)
			if !errors.Is(err, tc.want) {
				t.Fatalf("want %v, got %v", tc.want, err)
			}
			if strings.HasPrefix(tc.id, "37i9") && len(f.paths) != 0 {
				t.Fatal("editorial ids must be rejected before any request")
			}
		})
	}
}

func TestFetchSpotifyPlaylist_PaginationIsBounded(t *testing.T) {
	f := newSpotifyFake(t, func(w http.ResponseWriter, r *http.Request) {
		// Endless playlist: every page links to another.
		json.NewEncoder(w).Encode(itemsPage(100, spotifyPlaylistURL+"/abc/items?offset=100", "item"))
	})
	tracks, err := FetchSpotifyPlaylist(userCtx("u", nil), "abc")
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks) != MaxTracks {
		t.Fatalf("got %d tracks, want the %d cap", len(tracks), MaxTracks)
	}
	if len(f.paths) != 2 {
		t.Fatalf("expected 2 pages for 200 tracks, got %d", len(f.paths))
	}
}

func TestFetchSpotifyPlaylist_NeverFollowsForeignNextURL(t *testing.T) {
	var evil int
	evilSrv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { evil++ }))
	defer evilSrv.Close()
	newSpotifyFake(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(itemsPage(1, evilSrv.URL+"/steal", "item"))
	})
	if _, err := FetchSpotifyPlaylist(userCtx("u", nil), "abc"); err != nil {
		t.Fatal(err)
	}
	if evil != 0 {
		t.Fatal("followed a next URL outside the Spotify API with the credential")
	}
}

func TestFetchYouTubePlaylist_PagesAndBounds(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		items := make([]map[string]any, 50)
		for i := range items {
			items[i] = map[string]any{
				"snippet":        map[string]string{"title": "V", "videoOwnerChannelTitle": "C"},
				"contentDetails": map[string]string{"videoId": "vid"},
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"items": items, "nextPageToken": "more"})
	}))
	defer server.Close()
	old := youtubePlaylistURL
	youtubePlaylistURL = server.URL
	defer func() { youtubePlaylistURL = old }()
	t.Setenv("YOUTUBE_API_KEY", "test-key")

	tracks, err := FetchYouTubePlaylist(context.Background(), "PL1")
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks) != MaxTracks || calls != 4 {
		t.Fatalf("got %d tracks in %d calls, want %d in 4", len(tracks), calls, MaxTracks)
	}
}

// Transport errors embed the request URL, which carries the YouTube API key.
func TestFetchYouTubePlaylist_NetworkErrorDoesNotLeakKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close() // connection refused
	old := youtubePlaylistURL
	youtubePlaylistURL = url
	defer func() { youtubePlaylistURL = old }()
	t.Setenv("YOUTUBE_API_KEY", "SECRETKEY123")

	_, err := FetchYouTubePlaylist(context.Background(), "PL1")
	if err == nil {
		t.Fatal("expected a network error")
	}
	if strings.Contains(err.Error(), "key=") || strings.Contains(err.Error(), "SECRETKEY123") {
		t.Fatalf("error leaks the API key: %v", err)
	}
}
