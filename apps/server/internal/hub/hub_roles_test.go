package hub

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

const rolesRoom = "ROLES1"

// graceClock records grace timers so tests fire them by hand.
type graceClock struct {
	mu     sync.Mutex
	timers []*fakeTimer
}

type fakeTimer struct {
	d       time.Duration
	f       func()
	stopped bool
}

func (t *fakeTimer) Stop() bool { t.stopped = true; return true }

func (c *graceClock) after(d time.Duration, f func()) timerStopper {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{d: d, f: f}
	c.timers = append(c.timers, t)
	return t
}

func (c *graceClock) last() *fakeTimer {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.timers) == 0 {
		return nil
	}
	return c.timers[len(c.timers)-1]
}

// rolesJoin enrols a connection and runs room.join as that user.
func rolesJoin(t *testing.T, h *Hub, clientID, userID string) {
	t.Helper()
	h.RecordClientUserID(clientID, userID)
	h.Join(clientID, rolesRoom)
	if _, err := h.handleRPC("room.join", []byte(`{"roomId":"`+rolesRoom+`","name":"`+userID+`"}`), clientID, userID); err != nil {
		t.Fatalf("room.join %s: %v", userID, err)
	}
}

func rolesState(t *testing.T, h *Hub) queue.RoomState {
	t.Helper()
	room := mustRoom(t, h, rolesRoom)
	room.mu.Lock()
	defer room.mu.Unlock()
	cp := *room.State
	cp.Admins = append([]string(nil), room.State.Admins...)
	cp.Queue = append([]queue.TrackRef(nil), room.State.Queue...)
	return cp
}

func rolesRPC(h *Hub, method, body, clientID, userID string) error {
	_, err := h.handleRPC(method, []byte(body), clientID, userID)
	return err
}

func isUserError(err error) bool {
	var ue *UserError
	return errors.As(err, &ue)
}

func TestOwner_CreatorBecomesOwnerAndHost(t *testing.T) {
	h := NewHub(nil)
	rolesJoin(t, h, "c-o", "owner")
	rolesJoin(t, h, "c-b", "bob")
	s := rolesState(t, h)
	if s.OwnerUserID != "owner" || s.HostUserID != "owner" {
		t.Fatalf("owner=%q host=%q, want owner/owner", s.OwnerUserID, s.HostUserID)
	}
}

func TestOwner_ExistingRoomWithoutOwnerIsNotGuessed(t *testing.T) {
	h := NewHub(nil)
	room := mustRoom(t, h, rolesRoom)
	room.mu.Lock()
	room.State.HostUserID = "jack"
	room.State.Version = 7
	room.mu.Unlock()
	rolesJoin(t, h, "c-jack", "jack")
	rolesJoin(t, h, "c-o", "lucas")
	if s := rolesState(t, h); s.OwnerUserID != "" || s.HostUserID != "jack" {
		t.Fatalf("owner=%q host=%q, want no owner and jack still host", s.OwnerUserID, s.HostUserID)
	}
}

func TestShutdown_NoPromotion(t *testing.T) {
	h := NewHub(nil)
	rolesJoin(t, h, "c-o", "owner")
	rolesJoin(t, h, "c-j", "jack")
	h.BeginShutdown()
	h.PromoteOnDisconnect("c-o")
	h.Leave("c-o")
	if s := rolesState(t, h); s.HostUserID != "owner" {
		t.Fatalf("host = %q after shutdown disconnect, want owner kept", s.HostUserID)
	}
}

func graceHub(clock *graceClock) *Hub {
	h := NewHub(nil).WithHostGrace(DefaultHostGrace)
	h.roles.startedAt = time.Now().Add(-time.Hour) // outside the boot window
	h.roles.afterFunc = clock.after
	return h
}

// graceRoom builds a room whose host (hosty) is not the owner, so the owner
// reclaim rule stays out of the way.
func graceRoom(t *testing.T, h *Hub) {
	t.Helper()
	rolesJoin(t, h, "c-o", "owner")
	rolesJoin(t, h, "c-h", "hosty")
	rolesJoin(t, h, "c-b", "bob")
	if err := rolesRPC(h, "room.transfer_host", `{"roomId":"`+rolesRoom+`","userId":"hosty"}`, "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	h.Leave("c-o")
	h.RemoveClientUserID("c-o")
}

func TestHostGrace_PromotesAfterWindow(t *testing.T) {
	clock := &graceClock{}
	h := graceHub(clock)
	graceRoom(t, h)

	h.PromoteOnDisconnect("c-h")
	h.Leave("c-h")
	if s := rolesState(t, h); s.HostUserID != "hosty" {
		t.Fatalf("host = %q inside grace, want hosty held", s.HostUserID)
	}
	tm := clock.last()
	if tm == nil || tm.d != DefaultHostGrace {
		t.Fatalf("timer = %+v, want one armed for %s", tm, DefaultHostGrace)
	}
	tm.f()
	if s := rolesState(t, h); s.HostUserID != "bob" {
		t.Fatalf("host = %q after grace, want bob", s.HostUserID)
	}
}

func TestHostGrace_RejoinCancels(t *testing.T) {
	clock := &graceClock{}
	h := graceHub(clock)
	graceRoom(t, h)

	h.PromoteOnDisconnect("c-h")
	h.Leave("c-h")
	h.RemoveClientUserID("c-h")
	tm := clock.last()
	rolesJoin(t, h, "c-h2", "hosty")
	if !tm.stopped {
		t.Fatal("rejoin should stop the grace timer")
	}
	tm.f() // a timer that fired just before the stop must still be a no-op
	if s := rolesState(t, h); s.HostUserID != "hosty" {
		t.Fatalf("host = %q, want hosty kept", s.HostUserID)
	}
}

func TestHostGrace_OtherJoinerCannotClaimDuringWindow(t *testing.T) {
	clock := &graceClock{}
	h := graceHub(clock)
	graceRoom(t, h)
	h.PromoteOnDisconnect("c-h")
	h.Leave("c-h")
	h.RemoveClientUserID("c-h")
	rolesJoin(t, h, "c-n", "newbie")
	if s := rolesState(t, h); s.HostUserID != "hosty" {
		t.Fatalf("host = %q, a joiner must not claim a held host", s.HostUserID)
	}
}

func TestHostGrace_BootWindowHoldsPersistedHost(t *testing.T) {
	clock := &graceClock{}
	h := NewHub(nil).WithHostGrace(DefaultHostGrace) // just booted
	h.roles.afterFunc = clock.after
	room := mustRoom(t, h, rolesRoom)
	room.mu.Lock()
	room.State.HostUserID = "hosty"
	room.State.Version = 3
	room.mu.Unlock()
	rolesJoin(t, h, "c-j", "jack") // first to reconnect after the restart
	if s := rolesState(t, h); s.HostUserID != "hosty" {
		t.Fatalf("host = %q, want hosty held through the boot window", s.HostUserID)
	}
	clock.last().f() // host never came back
	if s := rolesState(t, h); s.HostUserID != "jack" {
		t.Fatalf("host = %q after the window, want jack", s.HostUserID)
	}
}

func TestHostGrace_ShutdownDropsTimers(t *testing.T) {
	clock := &graceClock{}
	h := graceHub(clock)
	graceRoom(t, h)
	h.PromoteOnDisconnect("c-h")
	h.BeginShutdown()
	if !clock.last().stopped {
		t.Fatal("BeginShutdown should stop pending grace timers")
	}
}

func TestHostGrace_RealTimer(t *testing.T) {
	h := NewHub(nil).WithHostGrace(40 * time.Millisecond)
	h.roles.startedAt = time.Now().Add(-time.Hour)
	graceRoom(t, h)
	h.PromoteOnDisconnect("c-h")
	h.Leave("c-h")
	waitFor(t, "promotion after the real timer", func() bool {
		return rolesState(t, h).HostUserID == "bob"
	})
}

func TestSetAdmin_Authz(t *testing.T) {
	h := NewHub(nil)
	rolesJoin(t, h, "c-o", "owner")
	rolesJoin(t, h, "c-a", "ann")
	rolesJoin(t, h, "c-b", "bob")
	set := func(client, user, target string, admin bool) error {
		b, _ := json.Marshal(map[string]any{"roomId": rolesRoom, "userId": target, "admin": admin})
		return rolesRPC(h, "room.set_admin", string(b), client, user)
	}
	// plain member cannot
	if err := set("c-b", "bob", "ann", true); err == nil || !isUserError(err) {
		t.Fatalf("member set_admin: got %v, want UserError", err)
	}
	// owner (also host) can
	if err := set("c-o", "owner", "ann", true); err != nil {
		t.Fatal(err)
	}
	if !isAdminNow(t, h, "ann") {
		t.Fatal("ann should be admin")
	}
	// admin cannot manage admins
	if err := set("c-a", "ann", "bob", true); err == nil {
		t.Fatal("admin set_admin should be refused")
	}
	// self target refused
	if err := set("c-o", "owner", "owner", true); err == nil {
		t.Fatal("self target should be refused")
	}
	// a host who is not the owner cannot touch the owner
	if err := rolesRPC(h, "room.transfer_host", `{"roomId":"`+rolesRoom+`","userId":"bob"}`, "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	if err := set("c-b", "bob", "owner", false); err == nil || !strings.Contains(err.Error(), "owner") {
		t.Fatalf("owner target: got %v", err)
	}
	// host (bob) can revoke
	if err := set("c-b", "bob", "ann", false); err != nil {
		t.Fatal(err)
	}
	if isAdminNow(t, h, "ann") {
		t.Fatal("ann should no longer be admin")
	}
	// idempotent revoke does not bump the version
	v := rolesState(t, h).Version
	if err := set("c-b", "bob", "ann", false); err != nil {
		t.Fatal(err)
	}
	if rolesState(t, h).Version != v {
		t.Fatal("no-op revoke bumped the version")
	}
}

func TestTransferHost_Authz(t *testing.T) {
	h := NewHub(nil)
	rolesJoin(t, h, "c-o", "owner")
	rolesJoin(t, h, "c-a", "ann")
	rolesJoin(t, h, "c-b", "bob")
	tr := func(client, user, target string) error {
		return rolesRPC(h, "room.transfer_host", `{"roomId":"`+rolesRoom+`","userId":"`+target+`"}`, client, user)
	}
	if err := tr("c-b", "bob", "ann"); err == nil {
		t.Fatal("plain member transfer should be refused")
	}
	if err := tr("c-o", "owner", "ghost"); err == nil || !isUserError(err) {
		t.Fatalf("absent target: got %v", err)
	}
	if err := tr("c-o", "owner", "ann"); err != nil {
		t.Fatal(err)
	}
	if rolesState(t, h).HostUserID != "ann" {
		t.Fatal("ann should be host")
	}
	// the owner may transfer even though ann is host
	if err := tr("c-o", "owner", "bob"); err != nil {
		t.Fatal(err)
	}
	if rolesState(t, h).HostUserID != "bob" {
		t.Fatal("bob should be host")
	}
	// an admin who is not host cannot transfer
	if err := rolesRPC(h, "room.set_admin", `{"roomId":"`+rolesRoom+`","userId":"ann","admin":true}`, "c-b", "bob"); err != nil {
		t.Fatal(err)
	}
	if err := tr("c-a", "ann", "ann"); err == nil {
		t.Fatal("admin transfer should be refused")
	}
	// transferring to the current host is a no-op
	v := rolesState(t, h).Version
	if err := tr("c-b", "bob", "bob"); err != nil {
		t.Fatal(err)
	}
	if rolesState(t, h).Version != v {
		t.Fatal("self transfer bumped the version")
	}
}

func TestKick_OwnerProtected(t *testing.T) {
	h := NewHub(nil)
	rolesJoin(t, h, "c-o", "owner")
	rolesJoin(t, h, "c-h", "hosty")
	if err := rolesRPC(h, "room.transfer_host", `{"roomId":"`+rolesRoom+`","userId":"hosty"}`, "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	err := rolesRPC(h, "room.kick", `{"roomId":"`+rolesRoom+`","clientId":"c-o"}`, "c-h", "hosty")
	if err == nil || !strings.Contains(err.Error(), "owner") {
		t.Fatalf("kicking the owner: got %v", err)
	}
	if !h.IsMember("c-o", rolesRoom) {
		t.Fatal("owner was removed")
	}
}

func TestAdminControl_AllQueueAndTransportRPCs(t *testing.T) {
	h := NewHub(nil).WithHostAssignment(true).WithSync(true).WithPublicRooms(true)
	rolesJoin(t, h, "c-o", "owner")
	rolesJoin(t, h, "c-a", "ann")
	rolesJoin(t, h, "c-b", "bob")
	if err := rolesRPC(h, "room.set_admin", `{"roomId":"`+rolesRoom+`","userId":"ann","admin":true}`, "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	// bob is host now; admin and owner keep control
	if err := rolesRPC(h, "room.transfer_host", `{"roomId":"`+rolesRoom+`","userId":"bob"}`, "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	cases := []struct{ method, body string }{
		{"now_playing.set", `"trackId":"z"`},
		{"now_playing.advance", `"afterId":"z"`},
		{"queue.reorder", `"trackId":"z","toIndex":0`},
		{"queue.remove", `"trackId":"z"`},
		{"radio.set", `"enabled":true`},
		{"playlist.import", `"url":"x"`},
		{"transport.play", `"positionMs":0`},
		{"transport.pause", `"positionMs":0`},
		{"transport.seek", `"positionMs":5`},
	}
	for _, c := range cases {
		data := []byte(`{"roomId":"` + rolesRoom + `",` + c.body + `}`)
		for _, who := range [][2]string{{"c-a", "ann"}, {"c-o", "owner"}, {"c-b", "bob"}} {
			if err := h.Authorize(newTestClient(who[0], who[1]), c.method, data); err != nil {
				t.Errorf("%s as %s: %v", c.method, who[1], err)
			}
		}
	}
	rolesJoin(t, h, "c-p", "plain")
	for _, c := range cases {
		data := []byte(`{"roomId":"` + rolesRoom + `",` + c.body + `}`)
		if err := h.Authorize(newTestClient("c-p", "plain"), c.method, data); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
			t.Errorf("%s as plain: got %v, want PermissionDenied", c.method, err)
		}
	}
	// admins do not get the host-only gate
	pub := []byte(`{"roomId":"` + rolesRoom + `","public":true}`)
	if err := h.Authorize(newTestClient("c-a", "ann"), "room.set_public", pub); !errors.Is(err, centrifuge.ErrorPermissionDenied) {
		t.Errorf("admin set_public: got %v, want PermissionDenied", err)
	}
	if err := h.Authorize(newTestClient("c-o", "owner"), "room.set_public", pub); err != nil {
		t.Errorf("owner set_public: %v", err)
	}
	if err := rolesRPC(h, "room.kick", `{"roomId":"`+rolesRoom+`","clientId":"c-p"}`, "c-a", "ann"); err == nil {
		t.Error("admin kick should be refused")
	}
}

func fixedMatcher(res *queue.SourceRef, err error) Matcher {
	return func(context.Context, string, string, string) (*queue.SourceRef, error) { return res, err }
}

func addTrack(t *testing.T, h *Hub, title string, sources string) {
	t.Helper()
	body := `{"roomId":"` + rolesRoom + `","track":{"title":"` + title + `","artist":"a","sources":` + sources + `,"addedBy":"x"}}`
	if err := rolesRPC(h, "queue.add", body, "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
}

func nowPlayingTitle(t *testing.T, h *Hub) string {
	s := rolesState(t, h)
	if tr := s.Track(s.NowPlayingID); tr != nil {
		return tr.Title
	}
	return ""
}

func TestAutoSkipSourceless_NoMatcher(t *testing.T) {
	h := NewHub(nil).WithAutoSkipSourceless(true)
	rolesJoin(t, h, "c-o", "owner")
	addTrack(t, h, "dead", `{}`)
	addTrack(t, h, "alive", `{"youtube":{"videoId":"abc","confidence":1}}`)
	if got := nowPlayingTitle(t, h); got != "alive" {
		t.Fatalf("now playing = %q, want the playable track", got)
	}
}

func TestAutoSkipSourceless_AfterMatcherMiss(t *testing.T) {
	h := NewHub(nil).WithAutoSkipSourceless(true).WithMatcher(fixedMatcher(nil, nil)).WithSpotifyMatcher(fixedMatcher(nil, nil))
	rolesJoin(t, h, "c-o", "owner")
	addTrack(t, h, "dead", `{}`)
	addTrack(t, h, "second", `{"youtube":{"videoId":"abc","confidence":1}}`)
	waitFor(t, "skip past the sourceless track", func() bool { return nowPlayingTitle(t, h) == "second" })
}

func TestAutoSkipSourceless_WaitsForPendingLookup(t *testing.T) {
	gate := make(chan struct{})
	slow := func(context.Context, string, string, string) (*queue.SourceRef, error) {
		<-gate
		return &queue.SourceRef{VideoID: "vid", Confidence: 0.9}, nil
	}
	h := NewHub(nil).WithAutoSkipSourceless(true).WithMatcher(slow)
	rolesJoin(t, h, "c-o", "owner")
	addTrack(t, h, "pending", `{}`)
	time.Sleep(30 * time.Millisecond)
	if got := nowPlayingTitle(t, h); got != "pending" {
		t.Fatalf("skipped while a lookup was in flight: %q", got)
	}
	close(gate)
	waitFor(t, "source applied", func() bool {
		s := rolesState(t, h)
		tr := s.Track(s.NowPlayingID)
		return tr != nil && tr.Sources.YouTube != nil
	})
}

func TestAutoSkipSourceless_MatcherErrorDoesNotSkip(t *testing.T) {
	h := NewHub(nil).WithAutoSkipSourceless(true).WithMatcher(fixedMatcher(nil, errors.New("quota")))
	rolesJoin(t, h, "c-o", "owner")
	addTrack(t, h, "flaky", `{}`)
	time.Sleep(60 * time.Millisecond)
	if got := nowPlayingTitle(t, h); got != "flaky" {
		t.Fatalf("an outage must not skip tracks: %q", got)
	}
}

func TestAutoSkipSourceless_OffByDefault(t *testing.T) {
	h := NewHub(nil)
	rolesJoin(t, h, "c-o", "owner")
	addTrack(t, h, "dead", `{}`)
	if got := nowPlayingTitle(t, h); got != "dead" {
		t.Fatal("auto skip must be opt-in")
	}
}

func TestAutoSkipSourceless_ExistingStuckTrackClearedOnNextMutation(t *testing.T) {
	h := NewHub(nil).WithAutoSkipSourceless(true)
	room := mustRoom(t, h, rolesRoom)
	room.mu.Lock()
	room.State.Queue = []queue.TrackRef{
		{ID: "t1", Title: "stuck"},
		{ID: "t2", Title: "next", Sources: queue.Sources{YouTube: &queue.SourceRef{VideoID: "v"}}},
	}
	room.State.NowPlayingID = "t1"
	room.State.Version = 4
	room.mu.Unlock()
	rolesJoin(t, h, "c-o", "owner")
	if got := rolesState(t, h).NowPlayingID; got != "t2" {
		t.Fatalf("now playing = %q, want t2", got)
	}
}

func TestRoleHelpers(t *testing.T) {
	s := &queue.RoomState{OwnerUserID: "g", HostUserID: "h", Admins: []string{"a", "z"}}
	for _, u := range []string{"g", "h", "a", "z"} {
		if !s.CanControl(u) {
			t.Errorf("%s should control", u)
		}
	}
	if s.CanControl("") || s.CanControl("nobody") {
		t.Fatal("outsiders must not control")
	}
	if ch, _ := s.SetAdmin("z", false); !ch || s.IsAdmin("z") {
		t.Fatal("SetAdmin revoke failed")
	}
}

func isAdminNow(t *testing.T, h *Hub, u string) bool {
	s := rolesState(t, h)
	return s.IsAdmin(u)
}
