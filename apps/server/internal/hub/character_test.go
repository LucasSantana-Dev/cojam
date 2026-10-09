package hub

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/centrifugal/centrifuge"
)

func characterReq(room string, id int) []byte {
	b, _ := json.Marshal(map[string]any{"roomId": room, "characterId": id})
	return b
}

func TestMemberSetCharacter_MembershipGate(t *testing.T) {
	h := NewHub(nil)
	if err := h.Authorize(newTestClient("x", ""), "member.set_character", characterReq("R", 3)); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("non-member: got %v, want PermissionDenied", err)
	}
	h.Join("c1", "R")
	if err := h.Authorize(newTestClient("c1", ""), "member.set_character", characterReq("R", 3)); err != nil {
		t.Fatalf("member: %v", err)
	}
}

func TestMemberSetCharacter_ValidatesRange(t *testing.T) {
	h := NewHub(nil)
	h.chatLimiter = nil // the range checks fire more RPCs than one burst
	h.Join("c1", "R")
	for _, bad := range []int{-1, 0, 15, 100} {
		if _, err := h.handleRPC("member.set_character", characterReq("R", bad), "c1", ""); err == nil {
			t.Fatalf("characterId %d accepted", bad)
		}
	}
	// A missing or non-integer id never reaches the store.
	for _, raw := range []string{`{"roomId":"R"}`, `{"roomId":"R","characterId":"3"}`, `{"roomId":"R","characterId":2.5}`} {
		if _, err := h.handleRPC("member.set_character", []byte(raw), "c1", ""); err == nil {
			t.Fatalf("payload %s accepted", raw)
		}
	}
	if _, ok := h.characters.get("c1"); ok {
		t.Fatal("rejected input was stored")
	}
	if _, err := h.handleRPC("member.set_character", characterReq("R", 1), "ghost", ""); err == nil {
		t.Fatal("non-member accepted")
	}
	for _, good := range []int{1, 7, 12, 13, 14} {
		if _, err := h.handleRPC("member.set_character", characterReq("R", good), "c1", ""); err != nil {
			t.Fatalf("id %d: %v", good, err)
		}
		if got, ok := h.characters.get("c1"); !ok || got != good {
			t.Fatalf("stored %d %v, want %d", got, ok, good)
		}
	}
}

func TestDefaultCharacter_StableAndInRange(t *testing.T) {
	// Pinned vectors: apps/web/lib/characters.test.ts holds the same table, so
	// the server and the web client draw the same default person.
	vectors := map[string]int{
		"":        2,
		"u-bia":   2,
		"u-caio":  12,
		"u-lucas": 6,
		"sb:abc":  3,
		"guest-7": 8,
	}
	for in, want := range vectors {
		if got := DefaultCharacter(in); got != want {
			t.Errorf("DefaultCharacter(%q) = %d, want %d", in, got, want)
		}
		if DefaultCharacter(in) != DefaultCharacter(in) {
			t.Errorf("DefaultCharacter(%q) not stable", in)
		}
	}
	seen := map[int]bool{}
	for i := 0; i < 2000; i++ {
		c := DefaultCharacter(fmt.Sprintf("user-%d", i))
		if !validCharacter(c) {
			t.Fatalf("default %d out of range", c)
		}
		seen[c] = true
	}
	if len(seen) != DefaultCharacterPool {
		t.Fatalf("hash reaches %d of %d characters", len(seen), DefaultCharacterPool)
	}
	for _, id := range []int{13, 14} {
		if seen[id] {
			t.Fatalf("character %d must never be a default", id)
		}
		if !validCharacter(id) {
			t.Fatalf("character %d must be pickable", id)
		}
	}
}

func TestMemberCharacters_OverlaySeedsLateJoinerAndForgetsLeavers(t *testing.T) {
	h := NewHub(nil)
	h.Join("c1", "R")
	h.Join("c2", "R")
	h.Join("c3", "OTHER")
	_, _ = h.handleRPC("member.set_character", characterReq("R", 5), "c1", "")
	_, _ = h.handleRPC("member.set_character", characterReq("OTHER", 9), "c3", "")

	read := func() map[string]int {
		raw, err := h.handleRPC("member.characters", []byte(`{"roomId":"R"}`), "c2", "")
		if err != nil {
			t.Fatal(err)
		}
		var out struct {
			Characters map[string]int `json:"characters"`
		}
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return out.Characters
	}
	got := read()
	if len(got) != 1 || got["c1"] != 5 {
		t.Fatalf("seed = %v, want only c1=5 (room-scoped, overrides only)", got)
	}
	// A later choice replaces the earlier one for the same connection.
	_, _ = h.handleRPC("member.set_character", characterReq("R", 2), "c1", "")
	if got := read(); got["c1"] != 2 {
		t.Fatalf("after change = %v, want c1=2", got)
	}
	h.Leave("c1")
	h.RemoveClientUserID("c1")
	if got := read(); len(got) != 0 {
		t.Fatalf("after leave = %v, want empty", got)
	}
}

func TestMemberSetCharacter_RegisteredAndRateLimited(t *testing.T) {
	if !chatMethods["member.set_character"] {
		t.Fatal("member.set_character must draw from the chat limiter")
	}
	if !knownMethods["member.set_character"] || !knownMethods["member.characters"] {
		t.Fatal("methods must be in knownMethods (bounded metric labels)")
	}
	h := NewHub(nil)
	h.Join("c1", "R")
	clock := &fakeClock{now: time.Now()}
	h.chatLimiter = newRateLimiter(2, time.Hour, clock.Now)
	for i := 0; i < 2; i++ {
		if _, err := h.handleRPC("member.set_character", characterReq("R", i+1), "c1", ""); err != nil {
			t.Fatalf("change %d within burst: %v", i+1, err)
		}
	}
	_, err := h.handleRPC("member.set_character", characterReq("R", 3), "c1", "")
	var ue *UserError
	if !errors.As(err, &ue) || ue.Error() != "too many requests, slow down" {
		t.Fatalf("burst+1: got %v, want the rate-limit UserError", err)
	}
	// The read is not limited.
	if _, err := h.handleRPC("member.characters", []byte(`{"roomId":"R"}`), "c1", ""); err != nil {
		t.Fatalf("member.characters limited: %v", err)
	}
}
