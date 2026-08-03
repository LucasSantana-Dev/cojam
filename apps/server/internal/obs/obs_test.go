package obs

import (
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestObserveRPC_CountsByMethodAndStatus(t *testing.T) {
	m := New()

	m.ObserveRPC("queue.add", "ok", 5*time.Millisecond)
	m.ObserveRPC("queue.add", "ok", 7*time.Millisecond)
	m.ObserveRPC("queue.add", "error", 1*time.Millisecond)

	if got := testutil.CollectAndCount(m.RPCDuration); got != 2 { // 2 label combos: ok + error
		t.Fatalf("label combos = %d, want 2", got)
	}
}

func TestConnectionsGauge(t *testing.T) {
	m := New()
	m.ConnInc()
	m.ConnInc()
	m.ConnDec()
	if got := testutil.ToFloat64(m.ConnectionsActive); got != 1 {
		t.Fatalf("connections_active = %v, want 1", got)
	}
}

func TestObserveMatchConfidence(t *testing.T) {
	m := New()
	m.ObserveMatchConfidence(0.85)
	if got := testutil.CollectAndCount(m.MatchConfidence); got != 1 {
		t.Fatalf("match confidence series = %d, want 1", got)
	}
}

func TestFailureAndAdoptionCounters(t *testing.T) {
	m := New()

	m.StoreError("load")
	m.StoreError("save")
	m.StoreError("save")
	m.StoreVersionGuardReject()
	m.RateLimitReject("queue.vote")
	m.RoomEvicted()
	m.PublishError()
	m.VoteCast()
	m.ChatMessageSent()
	m.RoomListed()
	m.RoomSetPublic(true)
	m.RoomSetPublic(false)

	if got := testutil.ToFloat64(m.StoreErrors.WithLabelValues("load")); got != 1 {
		t.Fatalf("store_errors_total{op=load} = %v, want 1", got)
	}
	if got := testutil.ToFloat64(m.StoreErrors.WithLabelValues("save")); got != 2 {
		t.Fatalf("store_errors_total{op=save} = %v, want 2", got)
	}
	if got := testutil.ToFloat64(m.StoreVersionGuardRejected); got != 1 {
		t.Fatalf("store_version_guard_rejected_total = %v, want 1", got)
	}
	if got := testutil.ToFloat64(m.RateLimitRejected.WithLabelValues("queue.vote")); got != 1 {
		t.Fatalf("rate_limit_rejected_total{method=queue.vote} = %v, want 1", got)
	}
	for name, c := range map[string]prometheus.Counter{
		"rooms_evicted":      m.RoomsEvicted,
		"publish_errors":     m.PublishErrors,
		"votes_cast":         m.VotesCast,
		"chat_messages_sent": m.ChatMessagesSent,
		"rooms_listed":       m.RoomsListed,
	} {
		if got := testutil.ToFloat64(c); got != 1 {
			t.Fatalf("%s = %v, want 1", name, got)
		}
	}
	if got := testutil.CollectAndCount(m.RoomsSetPublic); got != 2 {
		t.Fatalf("rooms_set_public series = %d, want 2 (true|false)", got)
	}
}
