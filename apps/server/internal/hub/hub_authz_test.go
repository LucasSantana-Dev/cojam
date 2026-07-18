package hub

import (
	"encoding/json"
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

// TestHostAssignment_FirstAuthenticatedJoinerBecomesHost tests that the first
// authenticated joiner (UserID non-empty) becomes the host.
func TestHostAssignment_FirstAuthenticatedJoinerBecomesHost(t *testing.T) {
	h := NewHub(nil)

	// Simulate alice joining with authentication
	h.RecordClientUserID("alice_client", "alice")
	h.Join("alice_client", "room1")

	res, err := h.HandleRPC("room.join", []byte(`{"roomId":"room1","name":"alice"}`), "alice")
	if err != nil {
		t.Fatalf("room.join alice: %v", err)
	}

	var state struct {
		HostUserID string `json:"hostUserId"`
	}
	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if state.HostUserID != "alice" {
		t.Fatalf("first authenticated joiner should be host: got %q, want alice", state.HostUserID)
	}
}

// TestHostAssignment_SecondAuthenticatedJoinerDoesNotOverwrite tests that the
// second authenticated joiner does not overwrite the host while the first is present.
func TestHostAssignment_SecondAuthenticatedJoinerDoesNotOverwrite(t *testing.T) {
	h := NewHub(nil)

	// alice joins first
	h.RecordClientUserID("alice_client", "alice")
	h.Join("alice_client", "room2")
	res, err := h.HandleRPC("room.join", []byte(`{"roomId":"room2","name":"alice"}`), "alice")
	if err != nil {
		t.Fatalf("room.join alice: %v", err)
	}

	var state struct {
		HostUserID string `json:"hostUserId"`
	}
	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("unmarshal alice: %v", err)
	}
	if state.HostUserID != "alice" {
		t.Fatalf("alice should be host: %q", state.HostUserID)
	}

	// bob joins
	h.RecordClientUserID("bob_client", "bob")
	h.Join("bob_client", "room2")
	res, err = h.HandleRPC("room.join", []byte(`{"roomId":"room2","name":"bob"}`), "bob")
	if err != nil {
		t.Fatalf("room.join bob: %v", err)
	}

	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("unmarshal bob: %v", err)
	}
	if state.HostUserID != "alice" {
		t.Fatalf("host should stay alice while alice is present: got %q", state.HostUserID)
	}
}

// TestHostAssignment_HostAbsentReclaim tests that if the host is not a present
// member, the next authenticated joiner claims host.
func TestHostAssignment_HostAbsentReclaim(t *testing.T) {
	h := NewHub(nil)

	// alice joins first
	h.RecordClientUserID("alice_client", "alice")
	h.Join("alice_client", "room3")
	res, err := h.HandleRPC("room.join", []byte(`{"roomId":"room3","name":"alice"}`), "alice")
	if err != nil {
		t.Fatalf("room.join alice: %v", err)
	}

	var state struct {
		HostUserID string `json:"hostUserId"`
	}
	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("unmarshal alice: %v", err)
	}
	if state.HostUserID != "alice" {
		t.Fatalf("alice should be host: %q", state.HostUserID)
	}

	// alice leaves
	h.Leave("alice_client")
	h.RemoveClientUserID("alice_client")

	// bob joins - should claim host since alice is not present
	h.RecordClientUserID("bob_client", "bob")
	h.Join("bob_client", "room3")
	res, err = h.HandleRPC("room.join", []byte(`{"roomId":"room3","name":"bob"}`), "bob")
	if err != nil {
		t.Fatalf("room.join bob: %v", err)
	}

	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("unmarshal bob: %v", err)
	}
	if state.HostUserID != "bob" {
		t.Fatalf("bob should claim host when alice left: got %q, want bob", state.HostUserID)
	}
}

// TestHostAssignment_AnonymousJoinerNoHost tests that when FEATURE_ROOM_AUTH
// is off (userID is empty), no host is assigned.
func TestHostAssignment_AnonymousJoinerNoHost(t *testing.T) {
	h := NewHub(nil)

	// Anonymous join (empty userID)
	h.Join("anon_client", "room4")
	res, err := h.HandleRPC("room.join", []byte(`{"roomId":"room4","name":"anonymous"}`), "")
	if err != nil {
		t.Fatalf("room.join anonymous: %v", err)
	}

	var state struct {
		HostUserID string `json:"hostUserId"`
	}
	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if state.HostUserID != "" {
		t.Fatalf("anonymous room should have no host: got %q, want empty", state.HostUserID)
	}
}

// TestHostAssignment_PersistenceRoundTrip tests that HostUserID marshals and
// unmarshals correctly, and that old snapshots without the field deserialize as empty.
func TestHostAssignment_PersistenceRoundTrip(t *testing.T) {
	h := NewHub(nil)

	// Create a room with a host
	h.RecordClientUserID("alice_client", "alice")
	h.Join("alice_client", "room5")
	res, err := h.HandleRPC("room.join", []byte(`{"roomId":"room5","name":"alice"}`), "alice")
	if err != nil {
		t.Fatalf("room.join: %v", err)
	}

	var state struct {
		HostUserID string `json:"hostUserId"`
		RoomID     string `json:"roomId"`
	}
	if err := json.Unmarshal(res, &state); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if state.HostUserID != "alice" {
		t.Fatalf("hostUserId should be alice: %q", state.HostUserID)
	}

	// Test backward compat: old snapshot without hostUserId should unmarshal as empty
	var oldState struct {
		HostUserID string `json:"hostUserId"`
		RoomID     string `json:"roomId"`
	}
	oldSnapshot := []byte(`{"roomId":"old_room","queue":[],"radioEnabled":false,"version":0}`)
	if err := json.Unmarshal(oldSnapshot, &oldState); err != nil {
		t.Fatalf("unmarshal old snapshot: %v", err)
	}
	if oldState.HostUserID != "" {
		t.Fatalf("old snapshot should have empty hostUserId: got %q", oldState.HostUserID)
	}
}
