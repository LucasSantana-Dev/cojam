package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

func TestHandleRPC_EmitsLogAndMetric(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	metrics := obs.New()
	h := NewHub(nil).WithObservability(logger, metrics)

	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"obs1","name":"x"}`), ""); err != nil {
		t.Fatalf("room.join: %v", err)
	}

	var rec map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rec); err != nil {
		t.Fatalf("no JSON log emitted: %v (buf=%q)", err, buf.String())
	}
	if rec["msg"] != "rpc" || rec["method"] != "room.join" || rec["room_id"] != "obs1" {
		t.Fatalf("log attrs wrong: %v", rec)
	}
	if _, ok := rec["duration_ms"]; !ok {
		t.Fatalf("missing duration_ms: %v", rec)
	}

	if got := testutil.CollectAndCount(metrics.RPCDuration); got != 1 {
		t.Fatalf("rpc metric series = %d, want 1", got)
	}
}

func TestHandleRPC_NoObservabilityConfigured_StillWorks(t *testing.T) {
	h := NewHub(nil)
	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"obs2","name":"x"}`), ""); err != nil {
		t.Fatalf("room.join without obs: %v", err)
	}
}

// #180: the first time a room gains a second concurrent member (its first
// non-creator member) the hub emits a structured log and bumps
// music_jam_rooms_shared_total — exactly once per room instance.
func TestJoin_FirstNonCreatorMember_EmitsLogAndMetricOnce(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	metrics := obs.New()
	h := NewHub(nil).WithObservability(logger, metrics)

	// The shared flag lives on the Room instance, so the room must exist.
	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"shared1","name":"host"}`), "c1"); err != nil {
		t.Fatalf("room.join: %v", err)
	}

	h.Join("c1", "shared1")
	if got := testutil.ToFloat64(metrics.RoomsShared); got != 0 {
		t.Fatalf("rooms_shared_total after solo member = %v, want 0", got)
	}

	h.Join("c2", "shared1")
	if got := testutil.ToFloat64(metrics.RoomsShared); got != 1 {
		t.Fatalf("rooms_shared_total after second member = %v, want 1", got)
	}
	if !strings.Contains(buf.String(), `"msg":"room_first_non_creator_member"`) ||
		!strings.Contains(buf.String(), `"room_id":"shared1"`) {
		t.Fatalf("missing room_first_non_creator_member log, buf=%q", buf.String())
	}

	// Re-joins and further members must not re-emit.
	h.Join("c2", "shared1")
	h.Join("c3", "shared1")
	if got := testutil.ToFloat64(metrics.RoomsShared); got != 1 {
		t.Fatalf("rooms_shared_total after extra joins = %v, want 1 (emit once)", got)
	}
}

// failingStore simulates a transient DB outage: Load and/or Save return a
// non-ErrNotFound error (#194).
type failingStore struct {
	loadErr error
	saveErr error
	saves   int
}

func (f *failingStore) Load(ctx context.Context, roomID string) (*queue.RoomState, error) {
	if f.loadErr != nil {
		return nil, f.loadErr
	}
	return nil, store.ErrNotFound
}

func (f *failingStore) Save(ctx context.Context, state *queue.RoomState) error {
	f.saves++
	return f.saveErr
}

func (f *failingStore) DeleteIdleRooms(ctx context.Context, cutoff time.Time, protected map[string]struct{}) (int64, error) {
	return 0, nil
}

// #194: a transient Load failure must fail the RPC with a retryable error
// instead of forking the room at version 0 (whose saves the version-guarded
// upsert would then silently drop).
func TestGetOrCreateRoom_LoadFailure_FailsRPC(t *testing.T) {
	metrics := obs.New()
	fs := &failingStore{loadErr: errors.New("db connection reset")}
	h := NewHub(nil).WithStore(fs).WithObservability(nil, metrics)

	_, err := h.HandleRPC("room.join", []byte(`{"roomId":"flake"}`), "")
	if err == nil {
		t.Fatal("transient store load failure must fail the RPC, not fork the room at v0")
	}
	var ue *UserError
	if !errors.As(err, &ue) {
		t.Fatalf("load failure must surface as a client-visible retryable error, got %T: %v", err, err)
	}

	h.mu.RLock()
	_, exists := h.rooms["flake"]
	h.mu.RUnlock()
	if exists {
		t.Fatal("failed load must not insert a fresh room into the hub")
	}
	if fs.saves != 0 {
		t.Fatalf("no fresh room may be persisted on load failure, saves = %d", fs.saves)
	}
	if got := testutil.ToFloat64(metrics.StoreErrors.WithLabelValues("load")); got != 1 {
		t.Fatalf("store_errors_total{op=load} = %v, want 1", got)
	}
}

// Save failures stay non-fatal to the RPC (write-through is best-effort) but
// must be counted, not invisible (#194/#195).
func TestMutate_SaveFailure_Counted(t *testing.T) {
	metrics := obs.New()
	fs := &failingStore{saveErr: errors.New("disk full")}
	h := NewHub(nil).WithStore(fs).WithObservability(nil, metrics)

	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"savefail","name":"x"}`), ""); err != nil {
		t.Fatalf("save failure must not fail the RPC: %v", err)
	}
	if got := testutil.ToFloat64(metrics.StoreErrors.WithLabelValues("save")); got != 1 {
		t.Fatalf("store_errors_total{op=save} = %v, want 1 (fresh-room persist)", got)
	}
}

// Rate-limit rejections get their own labeled counter instead of collapsing
// into status="error" on the RPC histogram (#195).
func TestRateLimit_RejectionCounted(t *testing.T) {
	metrics := obs.New()
	h := NewHub(nil).WithObservability(nil, metrics)
	h.fanoutLimiter = newRateLimiter(1, time.Hour, time.Now) // burst of 1, no refill

	if _, err := h.HandleRPC("track.search", searchPayload(), "u1"); err != nil {
		t.Fatalf("first request within burst: %v", err)
	}
	if _, err := h.HandleRPC("track.search", searchPayload(), "u1"); err == nil {
		t.Fatal("second request must be rate-limited")
	}
	if got := testutil.ToFloat64(metrics.RateLimitRejected.WithLabelValues("track.search")); got != 1 {
		t.Fatalf("rate_limit_rejected_total{method=track.search} = %v, want 1", got)
	}
}
