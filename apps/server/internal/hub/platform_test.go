package hub

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/centrifugal/centrifuge"
)

func platformReq(room, platform string) []byte {
	b, _ := json.Marshal(map[string]string{"roomId": room, "platform": platform})
	return b
}

func TestMemberSetPlatform_MembershipGate(t *testing.T) {
	h := NewHub(nil)
	if err := h.Authorize(newTestClient("x", ""), "member.set_platform", platformReq("R", "youtube")); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Fatalf("non-member: got %v, want PermissionDenied", err)
	}
	h.Join("c1", "R")
	if err := h.Authorize(newTestClient("c1", ""), "member.set_platform", platformReq("R", "youtube")); err != nil {
		t.Fatalf("member: %v", err)
	}
}

func TestMemberSetPlatform_ValidatesAndStores(t *testing.T) {
	h := NewHub(nil)
	h.Join("c1", "R")
	for _, bad := range []string{"", "deezer", "SPOTIFY"} {
		if _, err := h.handleRPC("member.set_platform", platformReq("R", bad), "c1", ""); err == nil {
			t.Fatalf("platform %q accepted", bad)
		}
	}
	if _, err := h.handleRPC("member.set_platform", platformReq("R", "youtube"), "ghost", ""); err == nil {
		t.Fatal("non-member accepted")
	}
	if _, err := h.handleRPC("member.set_platform", platformReq("R", "youtube"), "c1", ""); err != nil {
		t.Fatalf("valid: %v", err)
	}
	if p, ok := h.platforms.get("c1"); !ok || p != "youtube" {
		t.Fatalf("stored %q %v", p, ok)
	}
}

func TestMemberPlatforms_SeedsLateJoinerAndForgetsLeavers(t *testing.T) {
	h := NewHub(nil)
	h.Join("c1", "R")
	h.Join("c2", "R")
	h.Join("c3", "OTHER")
	_, _ = h.handleRPC("member.set_platform", platformReq("R", "youtube"), "c1", "")
	_, _ = h.handleRPC("member.set_platform", platformReq("OTHER", "apple"), "c3", "")

	read := func() map[string]string {
		raw, err := h.handleRPC("member.platforms", []byte(`{"roomId":"R"}`), "c2", "")
		if err != nil {
			t.Fatal(err)
		}
		var out struct {
			Platforms map[string]string `json:"platforms"`
		}
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return out.Platforms
	}
	got := read()
	if len(got) != 1 || got["c1"] != "youtube" {
		t.Fatalf("seed = %v, want only c1=youtube (room-scoped)", got)
	}
	h.Leave("c1")
	h.RemoveClientUserID("c1")
	if got := read(); len(got) != 0 {
		t.Fatalf("after leave = %v, want empty", got)
	}
}

func TestMemberSetPlatform_RegisteredAndRateLimited(t *testing.T) {
	if !chatMethods["member.set_platform"] {
		t.Fatal("member.set_platform must draw from the chat limiter")
	}
	if !knownMethods["member.set_platform"] || !knownMethods["member.platforms"] {
		t.Fatal("methods must be in knownMethods (bounded metric labels)")
	}
}
