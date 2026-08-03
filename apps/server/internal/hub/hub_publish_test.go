package hub

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// #178: a publish failure AFTER the mutation is committed (state mutated,
// version bumped, persisted) must not surface as the RPC error — the client
// would retry and duplicate the mutation. The RPC returns the new state, the
// failure is logged, and music_jam_publish_errors_total is incremented.
func TestMutate_PublishFailurePostCommit_ReturnsStateAndCountsMetric(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	metrics := obs.New()
	h := NewHub(nil).WithObservability(logger, metrics)
	h.publishFn = func(string, json.RawMessage) error { return errors.New("broker down") }

	data, err := h.mutate("pubfail", func(s *queue.RoomState) error {
		s.Add(queue.TrackRef{Title: "T", Artist: "A"})
		return nil
	})
	if err != nil {
		t.Fatalf("mutate returned error on publish failure: %v", err)
	}

	var state queue.RoomState
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatalf("unmarshal returned state: %v", err)
	}
	if len(state.Queue) != 1 || state.Queue[0].Title != "T" {
		t.Fatalf("mutation not visible in returned state: %+v", state.Queue)
	}

	if got := testutil.ToFloat64(metrics.PublishErrors); got != 1 {
		t.Fatalf("publish_errors_total = %v, want 1", got)
	}
	if !strings.Contains(buf.String(), `"msg":"publish_failed"`) ||
		!strings.Contains(buf.String(), `"room_id":"pubfail"`) {
		t.Fatalf("missing publish_failed log, buf=%q", buf.String())
	}
}

// Companion guard: with a healthy publisher the metric stays at zero.
func TestMutate_PublishSuccess_NoMetric(t *testing.T) {
	metrics := obs.New()
	h := NewHub(nil).WithObservability(nil, metrics)

	if _, err := h.mutate("pubok", func(s *queue.RoomState) error {
		s.Add(queue.TrackRef{Title: "T", Artist: "A"})
		return nil
	}); err != nil {
		t.Fatalf("mutate: %v", err)
	}
	if got := testutil.ToFloat64(metrics.PublishErrors); got != 0 {
		t.Fatalf("publish_errors_total = %v, want 0", got)
	}
}
