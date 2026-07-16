package hub

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/LucasSantana-Dev/music-jam/server/internal/obs"
)

func TestHandleRPC_EmitsLogAndMetric(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	metrics := obs.New()
	h := NewHub(nil).WithObservability(logger, metrics)

	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"obs1","name":"x"}`)); err != nil {
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
	if _, err := h.HandleRPC("room.join", []byte(`{"roomId":"obs2","name":"x"}`)); err != nil {
		t.Fatalf("room.join without obs: %v", err)
	}
}
