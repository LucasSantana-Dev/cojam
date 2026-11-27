package hub

import (
	"errors"
	"testing"

	"github.com/centrifugal/centrifuge"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// otherScreenRoom is a second valid 12-char room id.
const otherScreenRoom = "ZYXWVU654321"

// Runtime flags (migration 0012): a gate turned off reaches the next call.
func TestSetFeatures_GatesTheNextCall(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom()
	if _, err := r.call("c-host", "u-host", "chat.history", map[string]any{"roomId": screenRoom}); err != nil {
		t.Fatalf("chat on: %v", err)
	}
	r.h.SetFeatures(Features{ScreenShare: true})
	_, err := r.call("c-host", "u-host", "chat.history", map[string]any{"roomId": screenRoom})
	if !errors.Is(err, centrifuge.ErrorMethodNotFound) {
		t.Fatalf("chat off: got %v, want method not found", err)
	}
	r.h.SetFeatures(Features{Chat: true, ScreenShare: true})
	if _, err := r.call("c-host", "u-host", "chat.history", map[string]any{"roomId": screenRoom}); err != nil {
		t.Fatalf("chat back on: %v", err)
	}
}

// Turning screen share off ends the live share, with the trail, the metric
// and the notices, and refuses the next start.
func TestSetFeatures_ScreenOffEndsLiveShare(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom("v1")
	r.start("c-host", "u-host")
	if err := r.watch("c-v1", "u-v1"); err != nil {
		t.Fatal(err)
	}
	r.h.SetFeatures(Features{Chat: true, PublicRooms: true})
	if got := testutil.ToFloat64(r.metrics.ScreenSessionsEnded.WithLabelValues(screenEndDisabled)); got != 1 {
		t.Fatalf("disabled ends = %v, want 1", got)
	}
	if s := r.screen(); s != nil {
		t.Fatalf("share still live: %+v", s)
	}
	if len(r.sentTo("c-v1", "screen.ended")) == 0 {
		t.Fatal("viewer was not told the share ended")
	}
	if acts := r.auditActions(); len(acts) == 0 || acts[len(acts)-1] != "screen.stop" {
		t.Fatalf("trail = %v, want a final screen.stop", acts)
	}
	_, err := r.call("c-host", "u-host", "screen.start", map[string]any{"roomId": screenRoom, "ageAffirmed": true})
	if !errors.Is(err, centrifuge.ErrorMethodNotFound) {
		t.Fatalf("start while off: got %v, want method not found", err)
	}
}

// Narrowing the allowlist ends shares only in the rooms it drops.
func TestSetFeatures_AllowlistNarrowingEndsDroppedRooms(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom()
	r.start("c-host", "u-host")

	r.h.SetFeatures(Features{Chat: true, PublicRooms: true, ScreenShare: true, ScreenAllowlist: []string{screenRoom}})
	if r.screen() == nil {
		t.Fatal("a listed room lost its share")
	}
	r.h.SetFeatures(Features{Chat: true, PublicRooms: true, ScreenShare: true, ScreenAllowlist: []string{otherScreenRoom}})
	if r.screen() != nil {
		t.Fatal("a dropped room kept its share")
	}
	_, err := r.call("c-host", "u-host", "screen.start", map[string]any{"roomId": screenRoom, "ageAffirmed": true})
	wantUserError(t, err, "ainda não está disponível")
}
