package hub

import (
	"errors"
	"testing"

	"github.com/centrifugal/centrifuge"
)

// testClient is a minimal mock centrifuge.Client for testing.
type testClient struct {
	id     string
	userID string
}

func (tc *testClient) ID() string     { return tc.id }
func (tc *testClient) UserID() string { return tc.userID }

// newTestClient creates a test client with the given clientID and userID.
func newTestClient(clientID, userID string) *testClient {
	return &testClient{id: clientID, userID: userID}
}

// Authorize gates mutating RPCs on room membership: a client may only mutate a
// room it has joined (via room.join) or subscribed to. room.join itself enrolls
// and is always allowed; reads/unknown methods pass through to dispatch.
func TestAuthorize_MembershipGate(t *testing.T) {
	h := NewHub(nil)

	addX := []byte(`{"roomId":"x","track":{"title":"t","artist":"a","sources":{},"addedBy":"u"}}`)

	// A client that has not joined room x cannot mutate it.
	if err := h.Authorize(newTestClient("attacker", ""), "queue.add", addX); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("unjoined queue.add: got %v, want ErrorPermissionDenied", err)
	}

	// room.join enrolls the client and is always allowed.
	if err := h.Authorize(newTestClient("c1", ""), "room.join", []byte(`{"roomId":"x","name":"c1"}`)); err != nil {
		t.Fatalf("room.join should be allowed: %v", err)
	}
	if !h.IsMember("c1", "x") {
		t.Fatalf("room.join should enroll c1 in x")
	}

	// Now c1 can mutate x across every mutating method.
	for _, m := range []struct {
		method string
		data   string
	}{
		{"queue.add", `{"roomId":"x","track":{"title":"t","artist":"a","sources":{},"addedBy":"u"}}`},
		{"queue.remove", `{"roomId":"x","trackId":"z"}`},
		{"queue.reorder", `{"roomId":"x","trackId":"z","toIndex":0}`},
		{"now_playing.set", `{"roomId":"x","trackId":"z"}`},
		{"now_playing.advance", `{"roomId":"x","afterId":"z"}`},
	} {
		if err := h.Authorize(newTestClient("c1", ""), m.method, []byte(m.data)); err != nil {
			t.Fatalf("member %s on x: got %v, want nil", m.method, err)
		}
	}

	// c1 is NOT a member of a different room y.
	if err := h.Authorize(newTestClient("c1", ""), "queue.add", []byte(`{"roomId":"y","track":{"title":"t","artist":"a","sources":{},"addedBy":"u"}}`)); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("c1 mutating y: got %v, want ErrorPermissionDenied", err)
	}

	// Subscribe-based enrollment (reconnect path) also grants membership.
	h.Join("c2", "x")
	if err := h.Authorize(newTestClient("c2", ""), "queue.add", addX); err != nil {
		t.Fatalf("subscribed c2 on x: got %v, want nil", err)
	}

	// After leaving, membership is revoked.
	h.Leave("c2")
	if err := h.Authorize(newTestClient("c2", ""), "queue.add", addX); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("post-leave c2: got %v, want ErrorPermissionDenied", err)
	}
}
