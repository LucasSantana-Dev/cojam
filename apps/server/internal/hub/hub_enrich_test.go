package hub

import (
	"bytes"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestLaunchEnrichBounded pins #196: a burst of enrich jobs never exceeds
// enrichConcurrency live goroutines, total goroutines are capped at
// enrichMaxPending, and jobs beyond the bound are dropped (and logged)
// instead of parking on the semaphore.
func TestLaunchEnrichBounded(t *testing.T) {
	var logBuf bytes.Buffer
	h := NewHub(nil).WithObservability(slog.New(slog.NewTextHandler(&logBuf, nil)), nil)

	gate := make(chan struct{})
	var live, maxLive, done int32
	const burst = 100

	for i := 0; i < burst; i++ {
		h.launchEnrich(func() {
			n := atomic.AddInt32(&live, 1)
			for {
				m := atomic.LoadInt32(&maxLive)
				if n <= m || atomic.CompareAndSwapInt32(&maxLive, m, n) {
					break
				}
			}
			<-gate
			atomic.AddInt32(&live, -1)
			atomic.AddInt32(&done, 1)
		})
	}

	// Let the burst settle: live jobs fill the semaphore, the pending slots
	// fill behind them, the rest were already dropped synchronously.
	deadline := time.Now().Add(2 * time.Second)
	for atomic.LoadInt32(&live) < enrichConcurrency {
		if time.Now().After(deadline) {
			t.Fatalf("enrich jobs stalled: live=%d", atomic.LoadInt32(&live))
		}
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)

	if got := atomic.LoadInt32(&maxLive); got > enrichConcurrency {
		t.Fatalf("live enrich goroutines peaked at %d, want <= %d", got, enrichConcurrency)
	}
	if got := len(h.enrichPending); got != enrichMaxPending {
		t.Fatalf("pending slots = %d, want %d (rest dropped)", got, enrichMaxPending)
	}
	if !strings.Contains(logBuf.String(), "enrich_dropped") {
		t.Errorf("dropped jobs should be logged, got log: %q", logBuf.String())
	}

	close(gate)

	want := int32(enrichMaxPending)
	deadline = time.Now().Add(2 * time.Second)
	for atomic.LoadInt32(&done) < want {
		if time.Now().After(deadline) {
			t.Fatalf("only %d/%d admitted jobs completed", atomic.LoadInt32(&done), want)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got := atomic.LoadInt32(&done); got != want {
		t.Fatalf("completed %d jobs, want exactly %d (%d dropped)", got, want, burst-int(want))
	}
}
