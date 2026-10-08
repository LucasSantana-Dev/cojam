package hub

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/centrifugal/centrifuge"
)

func emoteReq(room, emote string) []byte {
	b, _ := json.Marshal(map[string]any{"roomId": room, "emote": emote})
	return b
}

func TestReactionEmote_Gate(t *testing.T) {
	if !mutatingMethods["reaction.emote"] || !knownMethods["reaction.emote"] {
		t.Fatal("reaction.emote must be membership gated and a known method")
	}
	h := NewHub(nil)
	if err := h.Authorize(newTestClient("x", ""), "reaction.emote", emoteReq("R", "fogo")); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("non-member: got %v, want PermissionDenied", err)
	}
	h.Join("c1", "R")
	h.Join("c2", "OTHER")
	log := &wootLog{}
	h.wootPublishFn = log.record
	if _, err := h.handleRPC("reaction.emote", emoteReq("R", "fogo"), "c2", ""); err == nil {
		t.Fatal("member of another room accepted")
	}
	if _, err := h.handleRPC("reaction.emote", []byte(`{"emote":"fogo"}`), "c1", ""); err == nil {
		t.Fatal("missing roomId accepted")
	}
	if len(log.pubs) != 0 {
		t.Fatalf("rejected calls published %d events", len(log.pubs))
	}
}

func TestReactionEmote_Allowlist(t *testing.T) {
	h := NewHub(nil)
	h.Join("c1", "R")
	log := &wootLog{}
	h.wootPublishFn = log.record
	for _, bad := range []string{"", "FOGO", "coração", "fogo ", "<b>", "woot"} {
		_, err := h.handleRPC("reaction.emote", emoteReq("R", bad), "c1", "")
		var ue *UserError
		if !errors.As(err, &ue) {
			t.Fatalf("emote %q: got %v, want a UserError", bad, err)
		}
	}
	if len(log.pubs) != 0 {
		t.Fatalf("rejected emotes published %d events", len(log.pubs))
	}
	// A rejected emote spent no token: the next valid one goes through.
	for _, ok := range []string{"amei"} {
		if _, err := h.handleRPC("reaction.emote", emoteReq("R", ok), "c1", ""); err != nil {
			t.Fatalf("emote %q: %v", ok, err)
		}
	}
}

func TestReactionEmote_Payload(t *testing.T) {
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
	raw, err := h.handleRPC("reaction.emote", emoteReq("R", "palmas"), "c1", "u-1")
	if err != nil {
		t.Fatalf("emote: %v", err)
	}
	var res map[string]string
	if err := json.Unmarshal(raw, &res); err != nil || res["clientId"] != "c1" || res["emote"] != "palmas" {
		t.Fatalf("result = %s (%v)", raw, err)
	}
	if len(log.pubs) != 1 {
		t.Fatalf("published %d events, want 1", len(log.pubs))
	}
	p := log.pubs[0]
	if p.room != "R" || p.payload["type"] != "reaction.emote" || p.payload["clientId"] != "c1" || p.payload["emote"] != "palmas" || len(p.payload) != 3 {
		t.Fatalf("publication = %s %v", p.room, p.payload)
	}
	room.mu.Lock()
	after := room.State.Version
	room.mu.Unlock()
	if after != before {
		t.Fatalf("reaction.emote bumped the room version %d -> %d", before, after)
	}
}

func TestReactionEmote_RateLimit(t *testing.T) {
	h := NewHub(nil)
	h.Join("c1", "R")
	h.Join("c3", "R")
	log := &wootLog{}
	h.wootPublishFn = log.record
	clock := &fakeClock{now: time.Now()}
	h.emoteLimiter = newRateLimiter(1, emoteInterval, clock.Now)
	// Its own bucket: an exhausted chat or woot budget does not block emotes.
	h.chatLimiter = newRateLimiter(1, time.Hour, clock.Now)
	h.chatLimiter.allow(rateLimitKey("c1", ""))
	h.reactionLimiter = newRateLimiter(1, time.Hour, clock.Now)
	h.reactionLimiter.allow(rateLimitKey("c1", ""))
	if _, err := h.handleRPC("reaction.emote", emoteReq("R", "uau"), "c1", ""); err != nil {
		t.Fatalf("first emote: %v", err)
	}
	_, err := h.handleRPC("reaction.emote", emoteReq("R", "uau"), "c1", "")
	var ue *UserError
	if !errors.As(err, &ue) || ue.Error() != "too many requests, slow down" {
		t.Fatalf("second emote within 600 ms: got %v, want the rate-limit UserError", err)
	}
	// Another connection has its own allowance.
	if _, err := h.handleRPC("reaction.emote", emoteReq("R", "rindo"), "c3", ""); err != nil {
		t.Fatalf("other connection: %v", err)
	}
	clock.mu.Lock()
	clock.now = clock.now.Add(emoteInterval)
	clock.mu.Unlock()
	if _, err := h.handleRPC("reaction.emote", emoteReq("R", "cantando"), "c1", ""); err != nil {
		t.Fatalf("after 600 ms: %v", err)
	}
	if len(log.pubs) != 3 {
		t.Fatalf("published %d, want 3", len(log.pubs))
	}
}
