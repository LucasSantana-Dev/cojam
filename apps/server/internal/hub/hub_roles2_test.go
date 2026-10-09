package hub

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

func TestOwner_DoesNotStealPresentHostOnJoin_ClaimHostDoes(t *testing.T) {
	h := NewHub(nil)
	rolesJoin(t, h, "c-o", "owner")
	rolesJoin(t, h, "c-j", "jack")
	if err := rolesRPC(h, "room.transfer_host", `{"roomId":"`+rolesRoom+`","userId":"jack"}`, "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	rolesJoin(t, h, "c-o2", "owner") // a refresh must not undo the transfer
	if s := rolesState(t, h); s.HostUserID != "jack" {
		t.Fatalf("host = %q, want jack kept", s.HostUserID)
	}
	claim := `{"roomId":"` + rolesRoom + `"}`
	if err := rolesRPC(h, "room.claim_host", claim, "c-j", "jack"); err == nil || !isUserError(err) {
		t.Fatalf("non-owner claim: got %v", err)
	}
	if err := rolesRPC(h, "room.claim_host", claim, "c-o2", "owner"); err != nil {
		t.Fatal(err)
	}
	if s := rolesState(t, h); s.HostUserID != "owner" {
		t.Fatalf("host = %q, want owner after claim", s.HostUserID)
	}
}

func TestOwner_ReclaimsWhenHostAbsent(t *testing.T) {
	h := NewHub(nil)
	room := mustRoom(t, h, rolesRoom)
	room.mu.Lock()
	room.State.OwnerUserID = "owner"
	room.State.HostUserID = "jack"
	room.State.Version = 5
	room.mu.Unlock()
	rolesJoin(t, h, "c-o", "owner") // jack is not connected
	if s := rolesState(t, h); s.HostUserID != "owner" {
		t.Fatalf("host = %q, want owner back", s.HostUserID)
	}
}

func TestOwner_ReclaimsThroughBootWindow(t *testing.T) {
	h := NewHub(nil).WithHostGrace(DefaultHostGrace) // just booted: others cannot claim
	room := mustRoom(t, h, rolesRoom)
	room.mu.Lock()
	room.State.OwnerUserID = "owner"
	room.State.HostUserID = "jack"
	room.State.Version = 5
	room.mu.Unlock()
	rolesJoin(t, h, "c-o", "owner")
	if s := rolesState(t, h); s.HostUserID != "owner" {
		t.Fatalf("host = %q, want owner back inside the boot window", s.HostUserID)
	}
}

func TestRadioAutoSkipDoesNotRunAway(t *testing.T) {
	var calls int32
	similar := func(context.Context, string, string, int) ([]queue.TrackRef, error) {
		n := atomic.AddInt32(&calls, 1)
		out := make([]queue.TrackRef, 5)
		for i := range out {
			out[i] = queue.TrackRef{Title: "sim" + string(rune('a'+i)) + string(rune('0'+n%10)), Artist: "x"}
		}
		return out, nil
	}
	h := NewHub(nil).WithAutoSkipSourceless(true).WithMatcher(fixedMatcher(nil, nil)).
		WithSpotifyMatcher(fixedMatcher(nil, nil)).WithSimilarProvider(similar)
	rolesJoin(t, h, "c-o", "owner")
	addTrack(t, h, "seed", `{"youtube":{"videoId":"abc","confidence":1}}`)
	if err := rolesRPC(h, "radio.set", `{"roomId":"`+rolesRoom+`","enabled":true}`, "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	seedID := rolesState(t, h).NowPlayingID
	if err := rolesRPC(h, "now_playing.advance", `{"roomId":"`+rolesRoom+`","afterId":"`+seedID+`"}`, "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "first refill", func() bool { return atomic.LoadInt32(&calls) >= 1 })
	time.Sleep(300 * time.Millisecond) // every sourceless pick gets looked up and skipped
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("similar called %d times, want exactly 1", got)
	}
	if n := len(rolesState(t, h).Queue); n > 6 {
		t.Fatalf("queue grew to %d", n)
	}
}

func TestRefillAllowed_OnePerWindow(t *testing.T) {
	h := NewHub(nil)
	if !h.refillAllowed("R1") || h.refillAllowed("R1") {
		t.Fatal("second refill inside the window must be refused")
	}
	if !h.refillAllowed("R2") {
		t.Fatal("other rooms are independent")
	}
}

func TestAutoSkipSourceless_UnknownStateIsLookedUpFirst(t *testing.T) {
	var lookups int32
	m := func(_ context.Context, title, _, _ string) (*queue.SourceRef, error) {
		// "next" is inside the YouTube window too; only the stored track's
		// lookups are under test (exactly one, never a second blind one).
		if title == "stored" {
			atomic.AddInt32(&lookups, 1)
		}
		return &queue.SourceRef{VideoID: "found", Confidence: 0.9}, nil
	}
	h := NewHub(nil).WithAutoSkipSourceless(true).WithMatcher(m)
	room := mustRoom(t, h, rolesRoom)
	room.mu.Lock()
	room.State.Queue = []queue.TrackRef{{ID: "t1", Title: "stored"}, {ID: "t2", Title: "next"}}
	room.State.NowPlayingID = "t1"
	room.State.Version = 4
	room.mu.Unlock()
	rolesJoin(t, h, "c-o", "owner")
	waitFor(t, "lookup applied", func() bool {
		st := rolesState(t, h)
		return st.Track("t1").Sources.YouTube != nil
	})
	if got := rolesState(t, h).NowPlayingID; got != "t1" {
		t.Fatalf("now playing = %q, a stored track must not be skipped blind", got)
	}
	if atomic.LoadInt32(&lookups) != 1 {
		t.Fatalf("lookups = %d, want 1", atomic.LoadInt32(&lookups))
	}
}

func TestRewriteAdmins_DedupesAndMoves(t *testing.T) {
	got := rewriteAdmins([]string{"g", "sb:1", "x"}, "g", "sb:1")
	if len(got) != 2 || got[0] != "sb:1" || got[1] != "x" {
		t.Fatalf("got %v", got)
	}
}

func TestRebind_CarriesOwnerAndAdmin(t *testing.T) {
	h := newRebindHub(t)
	const room = "REBROLE1"
	joinAs(h, "c-guest", "guest1", room)
	if _, err := h.handleRPC("room.join", []byte(`{"roomId":"`+room+`"}`), "c-guest", "guest1"); err != nil {
		t.Fatal(err)
	}
	r := mustRoom(t, h, room)
	r.mu.Lock()
	r.State.Admins = []string{"guest1", "sb:acct"}
	r.mu.Unlock()
	disconnectAs(h, "c-guest")
	joinAs(h, "c-auth", "sb:acct", room)
	proof := mintProof(t, rebindTestSecret, "guest1", time.Minute)
	if _, err := rebindCall(h, room, proof, "c-auth", "sb:acct"); err != nil {
		t.Fatal(err)
	}
	st := rebindState(t, h, room)
	if st.OwnerUserID != "sb:acct" || st.HostUserID != "sb:acct" {
		t.Fatalf("owner=%q host=%q", st.OwnerUserID, st.HostUserID)
	}
	if len(st.Admins) != 1 || st.Admins[0] != "sb:acct" {
		t.Fatalf("admins = %v, want one deduped entry", st.Admins)
	}
}
