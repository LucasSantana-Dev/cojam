package obs

import (
	"errors"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestObserveRPC_CountsByMethodAndStatus(t *testing.T) {
	m := New()

	m.ObserveRPC("queue.add", nil, 5*time.Millisecond)
	m.ObserveRPC("queue.add", nil, 7*time.Millisecond)
	m.ObserveRPC("queue.add", errors.New("boom"), 1*time.Millisecond)

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
