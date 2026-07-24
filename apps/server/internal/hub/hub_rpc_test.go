package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/cojam/server/internal/playlist"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// HandleRPC is the transport-independent RPC dispatch (protocol.md): every method
// takes roomId from params and returns the resulting RoomState.
func TestHandleRPC_RoomRouting(t *testing.T) {
	h := NewHub(nil) // nil node: publish skipped in tests

	// join creates the room named by params, not a default
	res, err := h.HandleRPC("room.join", []byte(`{"roomId":"demo42","name":"probe"}`), "")
	if err != nil {
		t.Fatalf("room.join: %v", err)
	}
	var st queue.RoomState
	if err := json.Unmarshal(res, &st); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if st.RoomID != "demo42" {
		t.Fatalf("joined room = %q, want demo42", st.RoomID)
	}

	// queue.add routes to the same room and returns full RoomState with bumped version
	res, err = h.HandleRPC("queue.add", []byte(`{"roomId":"demo42","track":{"title":"Me at the zoo","artist":"jawed","artworkUrl":"https://i.ytimg.com/vi/jNQXAC9IVRw/mqdefault.jpg","sources":{"youtube":{"videoId":"jNQXAC9IVRw","confidence":1}},"addedBy":"probe"}}`), "")
	if err != nil {
		t.Fatalf("queue.add: %v", err)
	}
	if err := json.Unmarshal(res, &st); err != nil {
		t.Fatalf("unmarshal add result: %v", err)
	}
	if st.RoomID != "demo42" || len(st.Queue) != 1 || st.Version != 1 {
		t.Fatalf("add result = roomId %q len %d version %d, want demo42/1/1", st.RoomID, len(st.Queue), st.Version)
	}
	if st.Queue[0].ArtworkURL != "https://i.ytimg.com/vi/jNQXAC9IVRw/mqdefault.jpg" {
		t.Fatalf("artworkUrl did not pass through, got %q", st.Queue[0].ArtworkURL)
	}
	if st.NowPlayingID != st.Queue[0].ID {
		t.Fatalf("first add should auto-set nowPlaying")
	}

	// separate room is isolated
	res, err = h.HandleRPC("room.join", []byte(`{"roomId":"other","name":"x"}`), "")
	if err != nil {
		t.Fatalf("room.join other: %v", err)
	}
	if err := json.Unmarshal(res, &st); err != nil {
		t.Fatalf("unmarshal other: %v", err)
	}
	if st.RoomID != "other" || len(st.Queue) != 0 {
		t.Fatalf("room isolation broken: %q len %d", st.RoomID, len(st.Queue))
	}

	// remove returns RoomState too
	res, _ = h.HandleRPC("room.join", []byte(`{"roomId":"demo42","name":"probe"}`), "")
	_ = json.Unmarshal(res, &st)
	trackID := st.Queue[0].ID
	res, err = h.HandleRPC("queue.remove", []byte(`{"roomId":"demo42","trackId":"`+trackID+`"}`), "")
	if err != nil {
		t.Fatalf("queue.remove: %v", err)
	}
	if err := json.Unmarshal(res, &st); err != nil {
		t.Fatalf("unmarshal remove result: %v", err)
	}
	if len(st.Queue) != 0 || st.Version != 2 {
		t.Fatalf("remove result len %d version %d, want 0/2", len(st.Queue), st.Version)
	}

	// unknown method errors
	if _, err := h.HandleRPC("nope", []byte(`{}`), ""); err == nil {
		t.Fatalf("unknown method should error")
	}
}

func TestHandleRPC_AdvanceAfter(t *testing.T) {
	h := NewHub(nil)

	// Set up a room with 3 tracks
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"demo","name":"probe"}`), "")
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	// Add first track
	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 1","artist":"A1","sources":{},"addedBy":"u1"}}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t1ID := st.Queue[0].ID

	// Add second track
	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 2","artist":"A2","sources":{},"addedBy":"u2"}}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t2ID := st.Queue[1].ID

	// Add third track
	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 3","artist":"A3","sources":{},"addedBy":"u3"}}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t3ID := st.Queue[2].ID

	// Initial NowPlayingID should be t1
	if st.NowPlayingID != t1ID {
		t.Fatalf("initial NowPlayingID should be %s, got %s", t1ID, st.NowPlayingID)
	}

	// Advance from t1 -> t2
	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"demo","afterId":"`+t1ID+`"}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	if st.NowPlayingID != t2ID {
		t.Fatalf("after 1st advance, NowPlayingID should be %s, got %s", t2ID, st.NowPlayingID)
	}
	// Version must bump or clients reject the publication (setState version guard).
	if st.Version != 4 {
		t.Fatalf("1st advance should bump version to 4, got %d", st.Version)
	}

	// No-op: a stale afterId (NowPlayingID already at t2) is idempotent and must
	// leave NowPlayingID and Version untouched.
	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"demo","afterId":"`+t1ID+`"}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	if st.NowPlayingID != t2ID {
		t.Fatalf("no-op advance should keep NowPlayingID %s, got %s", t2ID, st.NowPlayingID)
	}
	if st.Version != 4 {
		t.Fatalf("no-op advance should not bump version, got %d", st.Version)
	}

	// Advance from t2 -> t3
	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"demo","afterId":"`+t2ID+`"}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	if st.NowPlayingID != t3ID {
		t.Fatalf("after 2nd advance, NowPlayingID should be %s, got %s", t3ID, st.NowPlayingID)
	}
	if st.Version != 5 {
		t.Fatalf("2nd advance should bump version to 5, got %d", st.Version)
	}

	// Advance from t3 (last track) -> clears NowPlayingID
	res, _ = h.HandleRPC("now_playing.advance", []byte(`{"roomId":"demo","afterId":"`+t3ID+`"}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	if st.NowPlayingID != "" {
		t.Fatalf("advance past last track should clear NowPlayingID, got %s", st.NowPlayingID)
	}
	if st.Version != 6 {
		t.Fatalf("advance past last track should bump version to 6, got %d", st.Version)
	}
}

func TestHandleRPC_SetNowPlaying(t *testing.T) {
	h := NewHub(nil)

	// Set up a room with 2 tracks
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"demo","name":"probe"}`), "")
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 1","artist":"A1","sources":{},"addedBy":"u1"}}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 2","artist":"A2","sources":{},"addedBy":"u2"}}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t2ID := st.Queue[1].ID

	// Set now playing to t2
	res, err := h.HandleRPC("now_playing.set", []byte(`{"roomId":"demo","trackId":"`+t2ID+`"}`), "")
	if err != nil {
		t.Fatalf("now_playing.set: %v", err)
	}
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	if st.NowPlayingID != t2ID {
		t.Fatalf("NowPlayingID should be %s, got %s", t2ID, st.NowPlayingID)
	}
	// Version must bump or clients reject the publication (setState version guard).
	if st.Version != 3 {
		t.Fatalf("now_playing.set should bump version to 3, got %d", st.Version)
	}
}

func TestHandleRPC_QueueReorder(t *testing.T) {
	h := NewHub(nil)

	// Set up a room with 3 tracks
	res, _ := h.HandleRPC("room.join", []byte(`{"roomId":"demo","name":"probe"}`), "")
	st := &queue.RoomState{}
	_ = json.Unmarshal(res, st)

	// Add first track
	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 1","artist":"A1","sources":{},"addedBy":"u1"}}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t1ID := st.Queue[0].ID

	// Add second track
	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 2","artist":"A2","sources":{},"addedBy":"u2"}}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t2ID := st.Queue[1].ID

	// Add third track
	res, _ = h.HandleRPC("queue.add", []byte(`{"roomId":"demo","track":{"title":"Song 3","artist":"A3","sources":{},"addedBy":"u3"}}`), "")
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	t3ID := st.Queue[2].ID

	// Move t3 to index 0
	res, err := h.HandleRPC("queue.reorder", []byte(`{"roomId":"demo","trackId":"`+t3ID+`","toIndex":0}`), "")
	if err != nil {
		t.Fatalf("queue.reorder: %v", err)
	}
	st = &queue.RoomState{}
	_ = json.Unmarshal(res, st)
	if st.Queue[0].ID != t3ID {
		t.Fatalf("after reorder, queue[0] should be %s, got %s", t3ID, st.Queue[0].ID)
	}
	if st.Queue[1].ID != t1ID {
		t.Fatalf("after reorder, queue[1] should be %s, got %s", t1ID, st.Queue[1].ID)
	}
	if st.Queue[2].ID != t2ID {
		t.Fatalf("after reorder, queue[2] should be %s, got %s", t2ID, st.Queue[2].ID)
	}
	if st.Version != 4 {
		t.Fatalf("version should be 4, got %d", st.Version)
	}

	// NowPlayingID should not change (still t1)
	if st.NowPlayingID != t1ID {
		t.Fatalf("NowPlayingID should not change after reorder, got %s", st.NowPlayingID)
	}
}

func TestHandleRPC_TrackSearchNoSearcher(t *testing.T) {
	h := NewHub(nil) // no searcher configured

	res, err := h.HandleRPC("track.search", []byte(`{"query":"bohemian rhapsody"}`), "")
	if err != nil {
		t.Fatalf("track.search with no searcher should not error: %v", err)
	}

	var results []SearchResult
	if err := json.Unmarshal(res, &results); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("no searcher should return empty array, got %d results", len(results))
	}
}

// Regression: track.lyrics must be a registered dispatch case. The provider was
// once wired without the switch case, so the live RPC returned "104: method not
// found" while the stubbed provider tests still passed. This exercises dispatch.
func TestHandleRPC_TrackLyricsDispatch(t *testing.T) {
	// No provider configured: dispatch must still resolve (not "method not
	// found") and return an empty, well-formed result.
	h := NewHub(nil)
	res, err := h.HandleRPC("track.lyrics", []byte(`{"roomId":"R","artist":"Queen","title":"Bohemian Rhapsody"}`), "")
	if err != nil {
		t.Fatalf("track.lyrics with no provider should not error (got %v)", err)
	}
	var empty struct {
		Synced []any  `json:"synced"`
		Plain  string `json:"plain"`
		Source string `json:"source"`
	}
	if err := json.Unmarshal(res, &empty); err != nil {
		t.Fatalf("unmarshal empty: %v", err)
	}
	if empty.Source != "lrclib" || len(empty.Synced) != 0 {
		t.Fatalf("expected empty lrclib result, got %+v", empty)
	}

	// With a provider: dispatch routes to it and returns its payload.
	h.WithLyricsProvider(func(ctx context.Context, artist, title, album string, durationMs int) (interface{}, error) {
		return map[string]interface{}{
			"synced": []map[string]interface{}{{"timeMs": 12340, "text": "I've been tryna call"}},
			"plain":  "I've been tryna call",
			"source": "lrclib",
		}, nil
	})
	res, err = h.HandleRPC("track.lyrics", []byte(`{"roomId":"R","artist":"The Weeknd","title":"Blinding Lights","durationMs":200000}`), "")
	if err != nil {
		t.Fatalf("track.lyrics with provider: %v", err)
	}
	var got struct {
		Synced []struct {
			TimeMs int    `json:"timeMs"`
			Text   string `json:"text"`
		} `json:"synced"`
	}
	if err := json.Unmarshal(res, &got); err != nil {
		t.Fatalf("unmarshal got: %v", err)
	}
	if len(got.Synced) != 1 || got.Synced[0].TimeMs != 12340 {
		t.Fatalf("expected 1 synced line at 12340ms, got %+v", got.Synced)
	}
}

func TestHandleRPC_TrackSearchWithSearcher(t *testing.T) {
	h := NewHub(nil)

	// Mock searcher that returns fixed results
	h.WithSearcher(func(ctx context.Context, query string, prefer []string, limit int) ([]SearchResult, error) {
		return []SearchResult{
			{
				Title:      "Bohemian Rhapsody",
				Artist:     "Queen",
				SpotifyURI: "spotify:track:abc123",
				ISRC:       "GBUM71029604",
				DurationMs: 354400,
				ArtworkURL: "https://example.com/image.jpg",
			},
		}, nil
	})

	res, err := h.HandleRPC("track.search", []byte(`{"query":"bohemian rhapsody"}`), "")
	if err != nil {
		t.Fatalf("track.search: %v", err)
	}

	var results []SearchResult
	if err := json.Unmarshal(res, &results); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}

	r := results[0]
	if r.Title != "Bohemian Rhapsody" {
		t.Errorf("Title = %q, want Bohemian Rhapsody", r.Title)
	}
	if r.Artist != "Queen" {
		t.Errorf("Artist = %q, want Queen", r.Artist)
	}
	if r.SpotifyURI != "spotify:track:abc123" {
		t.Errorf("SpotifyURI = %q, want spotify:track:abc123", r.SpotifyURI)
	}
}

func TestHandleRPC_PlaylistImport(t *testing.T) {
	h := NewHub(nil)

	// Set up room membership
	h.Join("client1", "demo")

	// Mock playlist fetcher
	h.WithPlaylistFetcher(func(ctx context.Context, url string) ([]queue.TrackRef, error) {
		return []queue.TrackRef{
			{
				Title:      "Imported Track 1",
				Artist:     "Imported Artist 1",
				DurationMs: 180000,
				Sources:    queue.Sources{},
			},
			{
				Title:      "Imported Track 2",
				Artist:     "Imported Artist 2",
				DurationMs: 240000,
				Sources:    queue.Sources{},
			},
		}, nil
	})

	// Import a playlist
	res, err := h.HandleRPC("playlist.import", []byte(`{
		"roomId": "demo",
		"url": "https://www.deezer.com/en/playlist/123456",
		"addedBy": "testuser"
	}`), "")
	if err != nil {
		t.Fatalf("playlist.import: %v", err)
	}

	var st queue.RoomState
	if err := json.Unmarshal(res, &st); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(st.Queue) != 2 {
		t.Fatalf("expected 2 tracks in queue, got %d", len(st.Queue))
	}

	if st.Queue[0].Title != "Imported Track 1" {
		t.Errorf("track 0 title: got %q, want Imported Track 1", st.Queue[0].Title)
	}
	if st.Queue[0].AddedBy != "testuser" {
		t.Errorf("track 0 addedBy: got %q, want testuser", st.Queue[0].AddedBy)
	}

	if st.Queue[1].Title != "Imported Track 2" {
		t.Errorf("track 1 title: got %q, want Imported Track 2", st.Queue[1].Title)
	}

	if st.NowPlayingID != st.Queue[0].ID {
		t.Errorf("first track should be now playing")
	}
}

func TestHandleRPC_PlaylistImportQueueFull(t *testing.T) {
	h := NewHub(nil)
	h.Join("client1", "demo")

	// Mock fetcher returns many tracks
	h.WithPlaylistFetcher(func(ctx context.Context, url string) ([]queue.TrackRef, error) {
		tracks := make([]queue.TrackRef, 600)
		for i := range tracks {
			tracks[i] = queue.TrackRef{
				Title:   fmt.Sprintf("Track %d", i),
				Artist:  "Artist",
				Sources: queue.Sources{},
			}
		}
		return tracks, nil
	})

	res, err := h.HandleRPC("playlist.import", []byte(`{
		"roomId": "demo",
		"url": "https://example.com/playlist",
		"addedBy": "user"
	}`), "")
	if err != nil {
		t.Fatalf("playlist.import should not error when adding up to capacity: %v", err)
	}

	var st queue.RoomState
	if err := json.Unmarshal(res, &st); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(st.Queue) != queue.MaxQueueSize {
		t.Errorf("queue size: got %d, want %d", len(st.Queue), queue.MaxQueueSize)
	}
}

func TestHandleRPC_PlaylistImportClientTracks(t *testing.T) {
	h := NewHub(nil)
	h.Join("client1", "demo")

	// No playlist fetcher wired: client-supplied tracks must skip the fetcher gate.
	res, err := h.HandleRPC("playlist.import", []byte(`{
		"roomId": "demo",
		"url": "https://open.spotify.com/playlist/abc",
		"addedBy": "host",
		"tracks": [
			{"title":"Song One","artist":"Artist A","durationMs":200000,"isrc":"XX0000000001","sources":{"spotify":{"trackUri":"spotify:track:4uLU6hMCjMI75M1A2tKUQC"}}},
			{"title":"Song Two","artist":"Artist B","durationMs":210000,"sources":{"spotify":{"trackUri":"spotify:track:0VjIjW4GlUZAMYd2vXMi3b"}}}
		]
	}`), "")
	if err != nil {
		t.Fatalf("playlist.import with client tracks: %v", err)
	}

	var st queue.RoomState
	if err := json.Unmarshal(res, &st); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(st.Queue) != 2 {
		t.Fatalf("expected 2 tracks in queue, got %d", len(st.Queue))
	}
	if st.Queue[0].Title != "Song One" || st.Queue[0].AddedBy != "host" {
		t.Errorf("track 0: got %+v", st.Queue[0])
	}
	if st.Queue[0].Sources.Spotify == nil || st.Queue[0].Sources.Spotify.TrackURI != "spotify:track:4uLU6hMCjMI75M1A2tKUQC" {
		t.Errorf("track 0 spotify source lost: %+v", st.Queue[0].Sources)
	}
	// Version must reflect both adds (setState version guard on clients).
	if st.Version != 2 {
		t.Errorf("version: got %d, want 2 (one bump per added track)", st.Version)
	}
}

func TestHandleRPC_PlaylistImportClientTracksValidation(t *testing.T) {
	longTitle := strings.Repeat("x", 301)
	tooMany := make([]map[string]any, 0, 201)
	for i := 0; i < 201; i++ {
		tooMany = append(tooMany, map[string]any{"title": fmt.Sprintf("T%d", i), "artist": "A"})
	}
	tooManyJSON, _ := json.Marshal(tooMany)

	cases := []struct {
		name    string
		tracks  string
		wantErr string
	}{
		{"too many tracks", `"tracks":` + string(tooManyJSON), "too many tracks"},
		{"empty title", `"tracks":[{"title":"","artist":"A"}]`, "title"},
		{"title too long", `"tracks":[{"title":"` + longTitle + `","artist":"A"}]`, "title"},
		{"artist too long", `"tracks":[{"title":"T","artist":"` + longTitle + `"}]`, "artist"},
		{"negative duration", `"tracks":[{"title":"T","artist":"A","durationMs":-5}]`, "duration"},
		{"duration out of range", `"tracks":[{"title":"T","artist":"A","durationMs":99999999}]`, "duration"},
		{"isrc too long", `"tracks":[{"title":"T","artist":"A","isrc":"` + longTitle + `"}]`, "isrc"},
		{"youtube id too long", `"tracks":[{"title":"T","artist":"A","sources":{"youtube":{"videoId":"` + longTitle + `"}}}]`, "youtube"},
		{"apple id too long", `"tracks":[{"title":"T","artist":"A","sources":{"apple":{"songId":"` + longTitle + `"}}}]`, "apple"},
		{"bad spotify uri", `"tracks":[{"title":"T","artist":"A","sources":{"spotify":{"trackUri":"not-a-uri"}}}]`, "spotify"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHub(nil)
			h.Join("client1", "demo")
			payload := `{"roomId":"demo","url":"https://open.spotify.com/playlist/abc","addedBy":"host",` + tc.tracks + `}`
			_, err := h.HandleRPC("playlist.import", []byte(payload), "")
			if err == nil {
				t.Fatalf("expected validation error for %s", tc.name)
			}
			var ue *UserError
			if !errors.As(err, &ue) {
				t.Fatalf("validation error must be user-facing, got %T: %v", err, err)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error %q should mention %q", err.Error(), tc.wantErr)
			}
			// Queue must be untouched.
			room := h.GetOrCreateRoom("demo")
			room.mu.Lock()
			n := len(room.State.Queue)
			room.mu.Unlock()
			if n != 0 {
				t.Errorf("queue should be empty after rejected import, got %d tracks", n)
			}
		})
	}
}

func TestHandleRPC_PlaylistImportEmptyTracksNeedsFetcher(t *testing.T) {
	h := NewHub(nil)
	h.Join("client1", "demo")

	// Empty tracks array = no client data, so the fetcher gate still applies.
	_, err := h.HandleRPC("playlist.import", []byte(`{
		"roomId": "demo",
		"url": "https://open.spotify.com/playlist/abc",
		"addedBy": "host",
		"tracks": []
	}`), "")
	if err == nil {
		t.Fatal("expected error when no tracks and no fetcher configured")
	}
	if !strings.Contains(err.Error(), "not enabled") {
		t.Errorf("error %q should be the fetcher-not-enabled message", err.Error())
	}
}

func TestHandleRPC_PlaylistImportErrorsAreUserFacing(t *testing.T) {
	h := NewHub(nil)
	h.Join("client1", "demo")

	// Fetcher failing like a real unconfigured provider.
	h.WithPlaylistFetcher(func(ctx context.Context, url string) ([]queue.TrackRef, error) {
		return nil, playlist.ErrNotConfigured
	})

	cases := []struct {
		name    string
		payload string
		wantMsg string
	}{
		{"missing url", `{"roomId":"demo"}`, "enter a playlist URL"},
		{"service not configured", `{"roomId":"demo","url":"https://open.spotify.com/playlist/x"}`, "not configured on the server"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := h.HandleRPC("playlist.import", []byte(tc.payload), "")
			if err == nil {
				t.Fatal("expected error")
			}
			var ue *UserError
			if !errors.As(err, &ue) {
				t.Fatalf("error must be a UserError to reach the client, got %T: %v", err, err)
			}
			cerr := rpcClientError(err)
			var ce *centrifuge.Error
			if !errors.As(cerr, &ce) {
				t.Fatalf("rpcClientError must produce *centrifuge.Error, got %T", cerr)
			}
			if ce.Code != 400 {
				t.Errorf("code: got %d, want application code 400 (100 is masked as internal server error)", ce.Code)
			}
			if !strings.Contains(ce.Message, tc.wantMsg) {
				t.Errorf("message %q should contain %q", ce.Message, tc.wantMsg)
			}
		})
	}
}

func TestRPCClientErrorMasksNonUserErrors(t *testing.T) {
	err := rpcClientError(fmt.Errorf("db connection to 10.0.0.5 refused"))
	var ce *centrifuge.Error
	if errors.As(err, &ce) {
		t.Fatalf("internal errors must not be converted; centrifuge will mask them as code 100")
	}
}

func TestAuthorize_PlaylistImport(t *testing.T) {
	h := NewHub(nil)

	// Case 1: member can mutate
	h.Join("client1", "room1")
	err := h.Authorize(newTestClient("client1", ""), "playlist.import", []byte(`{"roomId":"room1"}`))
	if err != nil {
		t.Errorf("member should be authorized for playlist.import, got %v", err)
	}

	// Case 2: non-member cannot mutate
	err = h.Authorize(newTestClient("client2", ""), "playlist.import", []byte(`{"roomId":"room1"}`))
	if err == nil {
		t.Errorf("non-member should not be authorized for playlist.import")
	}
}

// track.lastfm dispatch test: verifies nil provider returns empty object
func TestHandleRPC_TrackLastfmDispatch(t *testing.T) {
	h := NewHub(nil)

	// No provider configured: dispatch must resolve and return empty result
	res, err := h.HandleRPC("track.lastfm", []byte(`{"roomId":"R","artist":"Queen","title":"Bohemian Rhapsody"}`), "")
	if err != nil {
		t.Fatalf("track.lastfm with no provider should not error (got %v)", err)
	}
	var empty struct {
		Playcount int      `json:"playcount"`
		Listeners int      `json:"listeners"`
		Tags      []string `json:"tags"`
		Source    string   `json:"source"`
	}
	if err := json.Unmarshal(res, &empty); err != nil {
		t.Fatalf("unmarshal empty: %v", err)
	}
	if empty.Source != "lastfm" || empty.Playcount != 0 || empty.Listeners != 0 {
		t.Fatalf("expected empty lastfm result, got %+v", empty)
	}

	// With a provider: dispatch routes to it and returns its payload
	h.WithLastfmEnrichProvider(func(ctx context.Context, artist, title string) (interface{}, error) {
		return map[string]interface{}{
			"playcount": 5000,
			"listeners": 3000,
			"tags":      []string{"rock", "classic"},
			"source":    "lastfm",
		}, nil
	})
	res, err = h.HandleRPC("track.lastfm", []byte(`{"roomId":"R","artist":"Queen","title":"Bohemian Rhapsody"}`), "")
	if err != nil {
		t.Fatalf("track.lastfm with provider: %v", err)
	}
	var got struct {
		Playcount int      `json:"playcount"`
		Listeners int      `json:"listeners"`
		Tags      []string `json:"tags"`
		Source    string   `json:"source"`
	}
	if err := json.Unmarshal(res, &got); err != nil {
		t.Fatalf("unmarshal got: %v", err)
	}
	if got.Playcount != 5000 || got.Listeners != 3000 || len(got.Tags) != 2 {
		t.Fatalf("expected playcount=5000, listeners=3000, tags=2, got %+v", got)
	}
}

// track.search must forward the caller's provider preferences to the searcher.
// Unknown providers pass through the hub untouched; the ranking layer
// (match.RankByProviders) owns the allowlist.
func TestHandleRPC_TrackSearchForwardsPrefer(t *testing.T) {
	h := NewHub(nil)

	var gotPrefer []string
	h.WithSearcher(func(ctx context.Context, query string, prefer []string, limit int) ([]SearchResult, error) {
		gotPrefer = prefer
		return []SearchResult{}, nil
	})

	if _, err := h.HandleRPC("track.search", []byte(`{"query":"q","prefer":["spotify","tidal"]}`), ""); err != nil {
		t.Fatalf("track.search: %v", err)
	}
	if len(gotPrefer) != 2 || gotPrefer[0] != "spotify" || gotPrefer[1] != "tidal" {
		t.Fatalf("prefer = %v, want [spotify tidal]", gotPrefer)
	}

	// Absent prefer: nil/empty reaches the searcher, order unchanged downstream.
	gotPrefer = []string{"sentinel"}
	if _, err := h.HandleRPC("track.search", []byte(`{"query":"q"}`), ""); err != nil {
		t.Fatalf("track.search without prefer: %v", err)
	}
	if len(gotPrefer) != 0 {
		t.Fatalf("prefer without param = %v, want empty", gotPrefer)
	}
}

func TestHandleRPC_QueueAddValidation(t *testing.T) {
	long := strings.Repeat("x", 301)

	cases := []struct {
		name    string
		track   string
		wantErr string
	}{
		{"empty title", `{"title":"","artist":"A"}`, "title"},
		{"title too long", `{"title":"` + long + `","artist":"A"}`, "title"},
		{"artist too long", `{"title":"T","artist":"` + long + `"}`, "artist"},
		{"negative duration", `{"title":"T","artist":"A","durationMs":-5}`, "duration"},
		{"duration out of range", `{"title":"T","artist":"A","durationMs":99999999}`, "duration"},
		{"isrc too long", `{"title":"T","artist":"A","isrc":"` + long + `"}`, "isrc"},
		{"addedBy too long", `{"title":"T","artist":"A","addedBy":"` + long + `"}`, "addedBy"},
		{"youtube id too long", `{"title":"T","artist":"A","sources":{"youtube":{"videoId":"` + long + `"}}}`, "youtube"},
		{"apple id too long", `{"title":"T","artist":"A","sources":{"apple":{"songId":"` + long + `"}}}`, "apple"},
		{"bad spotify uri", `{"title":"T","artist":"A","sources":{"spotify":{"trackUri":"not-a-uri"}}}`, "spotify"},
		{"artwork url too long", `{"title":"T","artist":"A","artworkUrl":"https://` + strings.Repeat("x", 513) + `"}`, "artwork"},
		{"artwork url not https", `{"title":"T","artist":"A","artworkUrl":"http://img.example.com/x.jpg"}`, "artwork"},
		{"artwork url javascript scheme", `{"title":"T","artist":"A","artworkUrl":"javascript:alert(1)"}`, "artwork"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHub(nil)
			h.Join("client1", "demo")
			payload := `{"roomId":"demo","track":` + tc.track + `}`
			_, err := h.HandleRPC("queue.add", []byte(payload), "")
			if err == nil {
				t.Fatalf("expected validation error for %s", tc.name)
			}
			var ue *UserError
			if !errors.As(err, &ue) {
				t.Fatalf("validation error must be user-facing, got %T: %v", err, err)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error %q should mention %q", err.Error(), tc.wantErr)
			}
			room := h.GetOrCreateRoom("demo")
			room.mu.Lock()
			n := len(room.State.Queue)
			room.mu.Unlock()
			if n != 0 {
				t.Errorf("queue should be empty after rejected add, got %d tracks", n)
			}
		})
	}
}

func TestHandleRPC_PlaylistImportAddedByTooLong(t *testing.T) {
	h := NewHub(nil)
	h.Join("client1", "demo")
	long := strings.Repeat("x", 301)
	payload := `{"roomId":"demo","url":"https://open.spotify.com/playlist/abc","addedBy":"` + long + `","tracks":[{"title":"T","artist":"A"}]}`
	_, err := h.HandleRPC("playlist.import", []byte(payload), "")
	if err == nil {
		t.Fatal("expected validation error for addedBy too long")
	}
	var ue *UserError
	if !errors.As(err, &ue) {
		t.Fatalf("validation error must be user-facing, got %T: %v", err, err)
	}
}
