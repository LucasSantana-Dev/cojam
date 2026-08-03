package hub

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// assertCode400 fails unless err is a client-visible UserError that crosses
// the transport as centrifuge application code 400 (not masked as 100).
func assertCode400(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error")
	}
	var ue *UserError
	if !errors.As(err, &ue) {
		t.Fatalf("got %T (%v), want *UserError", err, err)
	}
	cerr := rpcClientError(err)
	var ce *centrifuge.Error
	if !errors.As(cerr, &ce) {
		t.Fatalf("rpcClientError must produce *centrifuge.Error, got %T", cerr)
	}
	if ce.Code != 400 {
		t.Fatalf("code: got %d, want application code 400 (100 is masked as internal server error)", ce.Code)
	}
}

// --- #182: playlist.import is covered by the fanout rate limiter ---

// The (burst+1)th import within the window is rejected with the same
// code-400 "too many requests" UserError as the other fanout methods.
func TestPlaylistImport_RateLimited(t *testing.T) {
	h, _ := newTestHub(t, 1, time.Hour) // burst 1, no refill during the test
	h.WithPlaylistFetcher(func(ctx context.Context, url string) ([]queue.TrackRef, error) {
		return []queue.TrackRef{{Title: "S", Artist: "A"}}, nil
	})

	payload := []byte(`{"roomId":"imp_rl","url":"https://www.deezer.com/playlist/1","addedBy":"host"}`)
	if _, err := h.HandleRPC("playlist.import", payload, "u1"); err != nil {
		t.Fatalf("first import within burst: %v", err)
	}

	_, err := h.HandleRPC("playlist.import", payload, "u1")
	assertCode400(t, err)
	if !strings.Contains(err.Error(), "too many requests") {
		t.Fatalf("rejection message %q should be the too-many-requests UserError", err.Error())
	}

	// A different caller has their own bucket.
	if _, err := h.HandleRPC("playlist.import", payload, "u2"); err != nil {
		t.Fatalf("u2's first import must succeed: %v", err)
	}
}

// --- #184: track.search input validation ---

// Blank queries (empty, whitespace-only, absent) are rejected before any
// upstream fanout; the searcher must not be called.
func TestTrackSearch_RejectsBlankQuery(t *testing.T) {
	h := NewHub(nil)
	called := false
	h.WithSearcher(func(ctx context.Context, query string, prefer []string, limit int) ([]SearchResult, error) {
		called = true
		return nil, nil
	})

	for name, payload := range map[string]string{
		"empty":       `{"query":""}`,
		"whitespace":  `{"query":"   \t "}`,
		"absent":      `{}`,
		"only blanks": `{"query":" "}`,
	} {
		t.Run(name, func(t *testing.T) {
			_, err := h.HandleRPC("track.search", []byte(payload), "")
			assertCode400(t, err)
		})
	}
	if called {
		t.Fatal("searcher must not be called for a blank query")
	}
}

// Queries over maxSearchQueryLen chars are rejected (code 400); exactly at
// the cap passes through to the searcher.
func TestTrackSearch_QueryLengthCap(t *testing.T) {
	h := NewHub(nil)
	var gotQuery string
	h.WithSearcher(func(ctx context.Context, query string, prefer []string, limit int) ([]SearchResult, error) {
		gotQuery = query
		return []SearchResult{}, nil
	})

	_, err := h.HandleRPC("track.search", []byte(fmt.Sprintf(`{"query":%q}`, strings.Repeat("a", maxSearchQueryLen+1))), "")
	assertCode400(t, err)
	if !strings.Contains(err.Error(), "too long") {
		t.Fatalf("oversized query message %q should mention the length cap", err.Error())
	}

	atCap := strings.Repeat("a", maxSearchQueryLen)
	if _, err := h.HandleRPC("track.search", []byte(fmt.Sprintf(`{"query":%q}`, atCap)), ""); err != nil {
		t.Fatalf("query at the cap must pass: %v", err)
	}
	if gotQuery != atCap {
		t.Fatalf("searcher query: got %d chars, want the %d-char query", len(gotQuery), maxSearchQueryLen)
	}
}

// The query is trimmed before fanout, and prefer is truncated to the provider
// allowlist size (extras are never forwarded upstream).
func TestTrackSearch_TrimAndPreferCap(t *testing.T) {
	h := NewHub(nil)
	var gotQuery string
	var gotPrefer []string
	h.WithSearcher(func(ctx context.Context, query string, prefer []string, limit int) ([]SearchResult, error) {
		gotQuery = query
		gotPrefer = prefer
		return []SearchResult{}, nil
	})

	payload := `{"query":"  bohemian rhapsody  ","prefer":["spotify","deezer","apple","bogus1","bogus2"]}`
	if _, err := h.HandleRPC("track.search", []byte(payload), ""); err != nil {
		t.Fatalf("track.search: %v", err)
	}
	if gotQuery != "bohemian rhapsody" {
		t.Fatalf("query must be trimmed before fanout, got %q", gotQuery)
	}
	if len(gotPrefer) != maxSearchPrefer {
		t.Fatalf("prefer: got %d entries %v, want capped to %d", len(gotPrefer), gotPrefer, maxSearchPrefer)
	}
}

// --- #198: user-actionable queue errors map to code 400, not masked 100 ---

// queue.add on a full queue is a routine mistake: UserError, code 400.
func TestQueueAdd_QueueFullIsUserError(t *testing.T) {
	h := NewHub(nil)
	room := mustRoom(t, h, "full")
	room.mu.Lock()
	for i := 0; i < queue.MaxQueueSize; i++ {
		room.State.Add(queue.TrackRef{Title: "t", Artist: "a"})
	}
	room.mu.Unlock()

	_, err := h.HandleRPC("queue.add", []byte(`{"roomId":"full","track":{"title":"t","artist":"a","sources":{},"addedBy":"u"}}`), "")
	assertCode400(t, err)
	if !strings.Contains(err.Error(), "queue is full") {
		t.Fatalf("queue-full message %q should say the queue is full", err.Error())
	}
}

// Unknown-track mutations surface as code-400 UserErrors on every mutating
// RPC that takes a trackId, matching the queue.vote pattern.
func TestUnknownTrack_IsUserError(t *testing.T) {
	h := NewHub(nil).WithVoting(true)
	trackID := setupVotingRoom(t, h, "missing")

	cases := []struct {
		method  string
		payload []byte
	}{
		{"queue.remove", []byte(`{"roomId":"missing","trackId":"nope"}`)},
		{"now_playing.set", []byte(`{"roomId":"missing","trackId":"nope"}`)},
		{"queue.reorder", []byte(`{"roomId":"missing","trackId":"nope","toIndex":0}`)},
		// The pre-existing pattern: still mapped after the refactor.
		{"queue.vote", []byte(`{"roomId":"missing","trackId":"nope"}`)},
	}
	for _, tc := range cases {
		t.Run(tc.method, func(t *testing.T) {
			_, err := h.HandleRPC(tc.method, tc.payload, "alice")
			assertCode400(t, err)
		})
	}

	// Sanity: the real track still mutates fine through the same paths.
	if _, err := h.HandleRPC("queue.remove", []byte(fmt.Sprintf(`{"roomId":"missing","trackId":%q}`, trackID)), "alice"); err != nil {
		t.Fatalf("removing the real track must succeed: %v", err)
	}
}

// User mistakes land under status="user_error" so the "error" label counts
// only server faults (#198: honest RPC metrics).
func TestHandleRPC_UserErrorMetricStatus(t *testing.T) {
	metrics := obs.New()
	h := NewHub(nil).WithObservability(nil, metrics)
	setupVotingRoom(t, h, "metric") // seeds ok series for room.join + queue.add

	if _, err := h.HandleRPC("queue.remove", []byte(`{"roomId":"metric","trackId":"nope"}`), ""); err == nil {
		t.Fatal("queue.remove on unknown track should fail")
	}

	mfs, err := metrics.Registry.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	statuses := map[string]bool{}
	for _, mf := range mfs {
		if mf.GetName() != "music_jam_rpc_duration_seconds" {
			continue
		}
		for _, m := range mf.GetMetric() {
			method, status := "", ""
			for _, lp := range m.GetLabel() {
				switch lp.GetName() {
				case "method":
					method = lp.GetValue()
				case "status":
					status = lp.GetValue()
				}
			}
			if method == "queue.remove" {
				statuses[status] = true
			}
		}
	}
	if !statuses["user_error"] {
		t.Fatalf("queue.remove user mistake must be observed as user_error, got statuses %v", statuses)
	}
	if statuses["error"] {
		t.Fatalf("queue.remove user mistake must not increment the error label, got statuses %v", statuses)
	}
}
