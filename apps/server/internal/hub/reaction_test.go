package hub

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/centrifugal/centrifuge"
)

func wootReq(room string) []byte {
	b, _ := json.Marshal(map[string]any{"roomId": room})
	return b
}

type wootLog struct {
	mu   sync.Mutex
	pubs []struct {
		room    string
		payload map[string]any
	}
}

func (l *wootLog) record(room string, payload []byte) error {
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		return err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.pubs = append(l.pubs, struct {
		room    string
		payload map[string]any
	}{room, m})
	return nil
}

func TestReactionWoot_MembershipGate(t *testing.T) {
	h := NewHub(nil)
	if !mutatingMethods["reaction.woot"] {
		t.Fatal("reaction.woot must be membership gated (mutatingMethods)")
	}
	if err := h.Authorize(newTestClient("x", ""), "reaction.woot", wootReq("R")); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("non-member: got %v, want PermissionDenied", err)
	}
	h.Join("c1", "R")
	if err := h.Authorize(newTestClient("c1", ""), "reaction.woot", wootReq("R")); err != nil {
		t.Fatalf("member: %v", err)
	}
	// A member of another room is still rejected by the transport-independent path.
	h.Join("c2", "OTHER")
	log := &wootLog{}
	h.wootPublishFn = log.record
	if _, err := h.handleRPC("reaction.woot", wootReq("R"), "c2", ""); err == nil {
		t.Fatal("member of another room accepted")
	}
	if _, err := h.handleRPC("reaction.woot", wootReq("R"), "", ""); err == nil {
		t.Fatal("anonymous caller accepted")
	}
	if _, err := h.handleRPC("reaction.woot", []byte(`{}`), "c1", ""); err == nil {
		t.Fatal("missing roomId accepted")
	}
	if len(log.pubs) != 0 {
		t.Fatalf("rejected calls published %d events", len(log.pubs))
	}
}

func TestReactionWoot_BroadcastsOnRoomChannelOnly(t *testing.T) {
	h := NewHub(nil)
	h.Join("c1", "R")
	log := &wootLog{}
	h.wootPublishFn = log.record
	room, err := h.GetOrCreateRoom("R")
	if err != nil {
		t.Fatal(err)
	}
	room.mu.Lock()
	before := room.State.Version
	room.mu.Unlock()

	raw, err := h.handleRPC("reaction.woot", wootReq("R"), "c1", "u-1")
	if err != nil {
		t.Fatalf("woot: %v", err)
	}
	var res map[string]string
	if err := json.Unmarshal(raw, &res); err != nil || res["clientId"] != "c1" {
		t.Fatalf("result = %s (%v), want clientId c1", raw, err)
	}
	if len(log.pubs) != 1 {
		t.Fatalf("published %d events, want 1", len(log.pubs))
	}
	got := log.pubs[0]
	if got.room != "R" || got.payload["type"] != "reaction.woot" || got.payload["clientId"] != "c1" {
		t.Fatalf("publication = %s %v", got.room, got.payload)
	}
	if len(got.payload) != 2 {
		t.Fatalf("payload carries extra fields: %v", got.payload)
	}

	// Ephemeral: the room state is never versioned (or republished) by a reaction.
	room.mu.Lock()
	after := room.State.Version
	room.mu.Unlock()
	if after != before {
		t.Fatalf("reaction.woot bumped the room version %d -> %d", before, after)
	}
}

func TestReactionWoot_RegisteredAndRateLimited(t *testing.T) {
	if !chatMethods["reaction.woot"] {
		t.Fatal("reaction.woot must draw from the chat limiter")
	}
	if !knownMethods["reaction.woot"] {
		t.Fatal("reaction.woot must be in knownMethods (bounded metric labels)")
	}
	h := NewHub(nil)
	h.Join("c1", "R")
	log := &wootLog{}
	h.wootPublishFn = log.record
	clock := &fakeClock{now: time.Now()}
	h.chatLimiter = newRateLimiter(2, time.Hour, clock.Now)
	for i := 0; i < 2; i++ {
		if _, err := h.handleRPC("reaction.woot", wootReq("R"), "c1", ""); err != nil {
			t.Fatalf("woot %d within burst: %v", i+1, err)
		}
	}
	_, err := h.handleRPC("reaction.woot", wootReq("R"), "c1", "")
	var ue *UserError
	if !errors.As(err, &ue) || ue.Error() != "too many requests, slow down" {
		t.Fatalf("burst+1: got %v, want the rate-limit UserError", err)
	}
	if len(log.pubs) != 2 {
		t.Fatalf("published %d events, want 2 (the limited call must not publish)", len(log.pubs))
	}
}
