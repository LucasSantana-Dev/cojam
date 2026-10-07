package hub

import (
	"errors"
	"strings"
	"testing"

	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

// hostOnlyProbes are the host-gated RPCs checked in Authorize.
var hostOnlyProbes = []struct{ method, data string }{
	{"now_playing.set", `{"roomId":"HOSTGATE1","trackId":"t1"}`},
	{"now_playing.advance", `{"roomId":"HOSTGATE1","afterId":"t1"}`},
	{"queue.reorder", `{"roomId":"HOSTGATE1","trackId":"t1","toIndex":0}`},
	{"queue.remove", `{"roomId":"HOSTGATE1","trackId":"t1"}`},
	{"radio.set", `{"roomId":"HOSTGATE1","enabled":true}`},
	{"playlist.import", `{"roomId":"HOSTGATE1","url":"https://example.com/p"}`},
	{"room.set_public", `{"roomId":"HOSTGATE1","public":true}`},
	{"transport.play", `{"roomId":"HOSTGATE1"}`},
	{"transport.pause", `{"roomId":"HOSTGATE1"}`},
	{"transport.seek", `{"roomId":"HOSTGATE1","positionMs":1}`},
}

// restartedHub seeds a store with a room hosted by alice (bob is a plain
// member), then returns a fresh hub over the same store: the room is
// persisted but not resident, exactly the state after a process restart.
// bob is re-enrolled by subscription only, as centrifuge resubscribes do.
func restartedHub(t *testing.T) *Hub {
	t.Helper()
	st := store.NewMemory()

	before := NewHub(nil).WithStore(st)
	before.RecordClientUserID("alice_c", "alice")
	before.Join("alice_c", "HOSTGATE1")
	if _, err := before.HandleRPC("room.join", []byte(`{"roomId":"HOSTGATE1","name":"alice"}`), "alice"); err != nil {
		t.Fatalf("seed room.join: %v", err)
	}
	if got := before.GetHostUserID("HOSTGATE1"); got != "alice" {
		t.Fatalf("seed host = %q, want alice", got)
	}

	after := NewHub(nil).WithStore(st).WithChat(true).WithPublicRooms(true)
	after.RecordClientUserID("bob_c", "bob")
	after.Join("bob_c", "HOSTGATE1")
	after.RecordClientUserID("alice_c2", "alice")
	after.Join("alice_c2", "HOSTGATE1")
	return after
}

// After a restart the room is not in memory; the host gate must load it
// rather than read "no host" and wave a non-host member through.
func TestHostGate_AfterRestart_DeniesNonHost(t *testing.T) {
	h := restartedHub(t)
	bob := newTestClient("bob_c", "bob")
	for _, p := range hostOnlyProbes {
		if err := h.Authorize(bob, p.method, []byte(p.data)); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
			t.Fatalf("non-host %s after restart: got %v, want ErrorPermissionDenied", p.method, err)
		}
	}
}

func TestHostGate_AfterRestart_AllowsHost(t *testing.T) {
	h := restartedHub(t)
	alice := newTestClient("alice_c2", "alice")
	for _, p := range hostOnlyProbes {
		if err := h.Authorize(alice, p.method, []byte(p.data)); err != nil {
			t.Fatalf("host %s after restart: got %v, want nil", p.method, err)
		}
	}
}

// chat.delete and room.kick gate the host in dispatch (requireHost); the same
// restart state must not let a member moderate.
func TestHostGate_AfterRestart_ModerationDenied(t *testing.T) {
	for _, c := range []struct{ method, data string }{
		{"chat.delete", `{"roomId":"HOSTGATE1","messageId":"m1"}`},
		{"room.kick", `{"roomId":"HOSTGATE1","clientId":"alice_c2"}`},
	} {
		h := restartedHub(t) // fresh per method: the room must not be resident yet
		_, err := h.handleRPC(c.method, []byte(c.data), "bob_c", "bob")
		var ue *UserError
		if !errors.As(err, &ue) || !strings.HasPrefix(ue.Error(), "only the host") {
			t.Fatalf("non-host %s after restart: got %v, want the host-only UserError", c.method, err)
		}
		if !h.IsMember("alice_c2", "HOSTGATE1") {
			t.Fatalf("non-host %s after restart must have no effect", c.method)
		}
	}
}

// With host assignment on (every connection carries an identity), a room with
// no host bound is unclaimed: host-only actions fail closed until a joiner
// claims it through room.join.
func TestHostGate_NoHostBound_FailsClosedWhenAssignmentOn(t *testing.T) {
	h := NewHub(nil).WithChat(true).WithHostAssignment(true)
	h.RecordClientUserID("bob_c", "bob")
	h.Join("bob_c", "HOSTGATE1")

	bob := newTestClient("bob_c", "bob")
	for _, p := range hostOnlyProbes {
		if err := h.Authorize(bob, p.method, []byte(p.data)); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
			t.Fatalf("%s on a host-less room: got %v, want ErrorPermissionDenied", p.method, err)
		}
	}
	for _, c := range []struct{ method, data string }{
		{"chat.delete", `{"roomId":"HOSTGATE1","messageId":"m1"}`},
		{"room.kick", `{"roomId":"HOSTGATE1","clientId":"bob_c"}`},
	} {
		_, err := h.handleRPC(c.method, []byte(c.data), "bob_c", "bob")
		var ue *UserError
		if !errors.As(err, &ue) || !strings.HasPrefix(ue.Error(), "only the host") {
			t.Fatalf("%s on a host-less room: got %v, want the host-only UserError", c.method, err)
		}
	}

	// Claiming the room through room.join binds the host and unlocks control.
	if _, err := h.handleRPC("room.join", []byte(`{"roomId":"HOSTGATE1","name":"bob"}`), "bob_c", "bob"); err != nil {
		t.Fatalf("room.join: %v", err)
	}
	if err := h.Authorize(bob, "now_playing.set", []byte(`{"roomId":"HOSTGATE1","trackId":"t1"}`)); err != nil {
		t.Fatalf("host after claim: got %v, want nil", err)
	}
}

// With host assignment off (FEATURE_ROOM_AUTH off) host-less rooms keep the
// documented v0 equal-member behaviour.
func TestHostGate_NoHostBound_EqualMembersWhenAssignmentOff(t *testing.T) {
	h := NewHub(nil).WithChat(true).WithHostAssignment(false)
	h.Join("anon_c", "HOSTGATE1")
	anon := newTestClient("anon_c", "")
	for _, p := range hostOnlyProbes {
		if err := h.Authorize(anon, p.method, []byte(p.data)); err != nil {
			t.Fatalf("%s with host assignment off: got %v, want nil", p.method, err)
		}
	}
}
