package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/centrifugal/centrifuge"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

// screenRoom is a room id in the current 12-char generator format.
const screenRoom = "ABCDEF123456"

// sentMsg is one message captured by the sendToClient seam.
type sentMsg struct {
	to   string
	data map[string]any
}

// screenRig is a hub with screen share and room auth on, membership driven
// through serveRPC (so Authorize runs), and sendToClient captured.
type screenRig struct {
	t       *testing.T
	h       *Hub
	mu      sync.Mutex
	sent    []sentMsg
	gone    map[string]bool // clients whose sends fail
	audits  []auditRow
	metrics *obs.Metrics
}

type auditRow struct {
	action, roomID, actor, subject string
	detail                         map[string]any
}

func newScreenRig(t *testing.T) *screenRig {
	t.Helper()
	r := &screenRig{t: t, gone: map[string]bool{}, metrics: obs.New()}
	r.h = NewHub(nil).
		WithChat(true).
		WithPublicRooms(true).
		WithHostAssignment(true).
		WithScreenShare(true, nil).
		WithObservability(nil, r.metrics).
		WithScreenAudit(func(action, roomID, actor, subject string, detail map[string]any) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.audits = append(r.audits, auditRow{action, roomID, actor, subject, detail})
		})
	r.h.mutationLimiter = nil
	r.h.joinLimiter = nil
	r.h.chatLimiter = nil
	r.h.sendFn = func(clientID string, data []byte) error {
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.gone[clientID] {
			return errClientGone
		}
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatalf("sent invalid JSON: %v", err)
		}
		r.sent = append(r.sent, sentMsg{to: clientID, data: m})
		return nil
	}
	return r
}

// join enrolls clientID (identity userID, display name) in roomID through
// the transport path.
func (r *screenRig) join(roomID, clientID, userID string) {
	r.t.Helper()
	r.h.RecordClientUserID(clientID, userID)
	r.h.RecordClientName(clientID, "N-"+clientID)
	if _, err := r.call(clientID, userID, "room.join", map[string]any{"roomId": roomID}); err != nil {
		r.t.Fatalf("join %s: %v", clientID, err)
	}
}

// call runs one RPC through serveRPC (rate limits, Authorize, dispatch).
func (r *screenRig) call(clientID, userID, method string, params map[string]any) (json.RawMessage, error) {
	data, err := json.Marshal(params)
	if err != nil {
		r.t.Fatal(err)
	}
	return r.h.serveRPC(newTestClient(clientID, userID), method, data)
}

func (r *screenRig) mustCall(clientID, userID, method string, params map[string]any) json.RawMessage {
	r.t.Helper()
	res, err := r.call(clientID, userID, method, params)
	if err != nil {
		r.t.Fatalf("%s by %s: %v", method, clientID, err)
	}
	return res
}

func (r *screenRig) start(clientID, userID string) json.RawMessage {
	r.t.Helper()
	return r.mustCall(clientID, userID, "screen.start", map[string]any{"roomId": screenRoom, "ageAffirmed": true})
}

func (r *screenRig) watch(clientID, userID string) error {
	_, err := r.call(clientID, userID, "screen.watch", map[string]any{"roomId": screenRoom})
	return err
}

// screen returns the live projection as a member would see it.
func (r *screenRig) screen() *queue.ScreenShareState {
	r.t.Helper()
	res := r.mustCall("c-host", "u-host", "room.join", map[string]any{"roomId": screenRoom})
	var st queue.RoomState
	if err := json.Unmarshal(res, &st); err != nil {
		r.t.Fatal(err)
	}
	return st.Screen
}

func (r *screenRig) sentTo(clientID, typ string) []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []map[string]any
	for _, m := range r.sent {
		if m.to == clientID && m.data["type"] == typ {
			out = append(out, m.data)
		}
	}
	return out
}

func (r *screenRig) auditActions() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, a := range r.audits {
		out = append(out, a.action)
	}
	return out
}

// hostRoom creates screenRoom with c-host as host and the given members.
func (r *screenRig) hostRoom(members ...string) {
	r.t.Helper()
	r.join(screenRoom, "c-host", "u-host")
	for _, m := range members {
		r.join(screenRoom, "c-"+m, "u-"+m)
	}
}

func wantUserError(t *testing.T, err error, contains string) {
	t.Helper()
	var ue *UserError
	if !errors.As(err, &ue) {
		t.Fatalf("got %v (%T), want a *UserError containing %q", err, err, contains)
	}
	if !strings.Contains(ue.Error(), contains) {
		t.Fatalf("error %q does not contain %q", ue.Error(), contains)
	}
}

func TestScreen_FlagOffEveryMethodNotFound(t *testing.T) {
	h := NewHub(nil).WithHostAssignment(true)
	for method := range screenMethods {
		_, err := h.handleRPC(method, []byte(`{"roomId":"ABCDEF123456"}`), "c1", "u1")
		if !errors.Is(err, centrifuge.ErrorMethodNotFound) {
			t.Errorf("%s with the flag off: got %v, want ErrorMethodNotFound", method, err)
		}
	}
}

func TestScreen_NonMemberIsDenied(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom()
	for method := range screenMethods {
		_, err := r.call("c-stranger", "u-stranger", method, map[string]any{"roomId": screenRoom})
		if !errors.Is(err, centrifuge.ErrorPermissionDenied) {
			t.Errorf("%s by a non-member: got %v, want PermissionDenied", method, err)
		}
	}
}

func TestScreenStart_HostStartsAndStateIsProjected(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom("ana")
	var st queue.RoomState
	if err := json.Unmarshal(r.start("c-host", "u-host"), &st); err != nil {
		t.Fatal(err)
	}
	if st.Screen == nil || st.Screen.BroadcasterID != "c-host" || st.Screen.MaxViewers != screenMaxViewers ||
		st.Screen.BroadcasterName != "N-c-host" || st.Screen.StartedAtMs == 0 {
		t.Fatalf("screen projection = %+v", st.Screen)
	}
	if got := testutil.ToFloat64(r.metrics.ScreenSessionsStarted); got != 1 {
		t.Fatalf("sessions started = %v, want 1", got)
	}
	if got := r.auditActions(); len(got) != 1 || got[0] != "screen.start" {
		t.Fatalf("trail = %v, want [screen.start]", got)
	}
	if r.audits[0].detail["ageAffirmed"] != true {
		t.Fatalf("trail detail = %v, want ageAffirmed true", r.audits[0].detail)
	}
}

func TestScreenStart_Refusals(t *testing.T) {
	t.Run("non-host", func(t *testing.T) {
		r := newScreenRig(t)
		r.hostRoom("ana")
		_, err := r.call("c-ana", "u-ana", "screen.start", map[string]any{"roomId": screenRoom, "ageAffirmed": true})
		wantUserError(t, err, "host")
	})
	t.Run("age not affirmed", func(t *testing.T) {
		r := newScreenRig(t)
		r.hostRoom()
		_, err := r.call("c-host", "u-host", "screen.start", map[string]any{"roomId": screenRoom})
		wantUserError(t, err, "idade")
	})
	t.Run("legacy short room id", func(t *testing.T) {
		r := newScreenRig(t)
		r.join("ABC123", "c-host", "u-host")
		_, err := r.call("c-host", "u-host", "screen.start", map[string]any{"roomId": "ABC123", "ageAffirmed": true})
		wantUserError(t, err, "link de sala mais novo")
	})
	t.Run("public room", func(t *testing.T) {
		r := newScreenRig(t)
		r.hostRoom()
		r.mustCall("c-host", "u-host", "room.set_public", map[string]any{"roomId": screenRoom, "public": true})
		_, err := r.call("c-host", "u-host", "screen.start", map[string]any{"roomId": screenRoom, "ageAffirmed": true})
		wantUserError(t, err, "salas privadas")
	})
	t.Run("allowlist excludes the room", func(t *testing.T) {
		r := newScreenRig(t)
		r.h.WithScreenShare(true, []string{"ZZZZZZZZZZZZ"})
		r.hostRoom()
		_, err := r.call("c-host", "u-host", "screen.start", map[string]any{"roomId": screenRoom, "ageAffirmed": true})
		wantUserError(t, err, "ainda não está disponível")
	})
	t.Run("allowlist includes the room", func(t *testing.T) {
		r := newScreenRig(t)
		r.h.WithScreenShare(true, []string{" ZZZZZZZZZZZZ", screenRoom + " "})
		r.hostRoom()
		r.start("c-host", "u-host")
	})
	t.Run("second broadcaster", func(t *testing.T) {
		r := newScreenRig(t)
		r.hostRoom("ana")
		r.start("c-host", "u-host")
		r.mustCall("c-host", "u-host", "room.transfer_host", map[string]any{"roomId": screenRoom, "userId": "u-ana"})
		_, err := r.call("c-ana", "u-ana", "screen.start", map[string]any{"roomId": screenRoom, "ageAffirmed": true})
		wantUserError(t, err, "já está compartilhando")
	})
}

// An empty HostUserID is a refusal, never "everyone is host".
func TestScreenStart_EmptyHostFailsClosed(t *testing.T) {
	r := newScreenRig(t)
	// A member with no identity binds no host.
	r.join(screenRoom, "c-anon", "")
	_, err := r.call("c-anon", "", "screen.start", map[string]any{"roomId": screenRoom, "ageAffirmed": true})
	wantUserError(t, err, "host")
}

func TestScreenStart_SameUserTakeover(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom("ana")
	r.start("c-host", "u-host")
	if err := r.watch("c-ana", "u-ana"); err != nil {
		t.Fatal(err)
	}
	// The host reloads: new connection, same identity, old one not yet gone.
	r.join(screenRoom, "c-host2", "u-host")
	r.start("c-host2", "u-host")

	sc := r.screen()
	if sc == nil || sc.BroadcasterID != "c-host2" || sc.ViewerCount != 0 {
		t.Fatalf("after takeover screen = %+v, want broadcaster c-host2 with no viewers", sc)
	}
	if got := testutil.ToFloat64(r.metrics.ScreenSessionsEnded.WithLabelValues(screenEndTakeover)); got != 1 {
		t.Fatalf("takeover ends = %v, want 1", got)
	}
	// The old connection's index entries are gone: its disconnect is a no-op.
	r.h.ScreenOnDisconnect("c-host")
	if sc := r.screen(); sc == nil || sc.BroadcasterID != "c-host2" {
		t.Fatalf("old connection's disconnect ended the new share: %+v", sc)
	}
}

func TestScreenStop_BroadcasterAndHost(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom("ana", "bia")
	r.start("c-host", "u-host")
	// A non-host member cannot stop someone else's share.
	_, err := r.call("c-bia", "u-bia", "screen.stop", map[string]any{"roomId": screenRoom})
	wantUserError(t, err, "host")
	r.mustCall("c-host", "u-host", "screen.stop", map[string]any{"roomId": screenRoom})
	if r.screen() != nil {
		t.Fatal("share still live after stop")
	}
	// Stopping again is a no-op, not an error.
	r.mustCall("c-host", "u-host", "screen.stop", map[string]any{"roomId": screenRoom})

	// The host stops a share it does not own: Ana broadcasts after a host
	// transfer and the new host (Ana) hands it back first.
	r.mustCall("c-host", "u-host", "room.transfer_host", map[string]any{"roomId": screenRoom, "userId": "u-ana"})
	r.start("c-ana", "u-ana")
	r.mustCall("c-ana", "u-ana", "room.transfer_host", map[string]any{"roomId": screenRoom, "userId": "u-host"})
	r.mustCall("c-host", "u-host", "screen.stop", map[string]any{"roomId": screenRoom})
	got := r.auditActions()
	want := []string{"screen.start", "screen.stop", "screen.start", "screen.host_stop"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("trail = %v, want %v", got, want)
	}
	if got := testutil.ToFloat64(r.metrics.ScreenSessionsEnded.WithLabelValues(screenEndHostStopped)); got != 1 {
		t.Fatalf("host_stopped ends = %v, want 1", got)
	}
}

func TestSetPublic_RefusedWhileLive(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom()
	r.start("c-host", "u-host")
	_, err := r.call("c-host", "u-host", "room.set_public", map[string]any{"roomId": screenRoom, "public": true})
	wantUserError(t, err, "Encerre o compartilhamento")
	r.mustCall("c-host", "u-host", "room.set_public", map[string]any{"roomId": screenRoom, "public": false})
}

// screen.start and room.set_public serialize under the room lock: never both.
func TestScreenStartVsSetPublic_NeverBoth(t *testing.T) {
	for i := 0; i < 100; i++ {
		r := newScreenRig(t)
		r.hostRoom()
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, _ = r.call("c-host", "u-host", "screen.start", map[string]any{"roomId": screenRoom, "ageAffirmed": true})
		}()
		go func() {
			defer wg.Done()
			_, _ = r.call("c-host", "u-host", "room.set_public", map[string]any{"roomId": screenRoom, "public": true})
		}()
		wg.Wait()
		res := r.mustCall("c-host", "u-host", "room.join", map[string]any{"roomId": screenRoom})
		var st queue.RoomState
		if err := json.Unmarshal(res, &st); err != nil {
			t.Fatal(err)
		}
		if st.Public && st.Screen != nil {
			t.Fatalf("iteration %d: room is public with a live share", i)
		}
	}
}

func TestScreenWatch_AdmissionRules(t *testing.T) {
	r := newScreenRig(t)
	members := []string{"v1", "v2", "v3", "v4", "v5", "v6"}
	r.hostRoom(members...)
	r.start("c-host", "u-host")

	// Self.
	wantUserError(t, r.watch("c-host", "u-host"), "Você é quem")
	// Five slots, the sixth refused.
	for _, m := range members[:5] {
		if err := r.watch("c-"+m, "u-"+m); err != nil {
			t.Fatalf("watch %s: %v", m, err)
		}
	}
	wantUserError(t, r.watch("c-v6", "u-v6"), "cheio")
	if sc := r.screen(); sc.ViewerCount != 5 {
		t.Fatalf("viewerCount = %d, want 5", sc.ViewerCount)
	}
	// The broadcaster was told about each admission.
	if got := len(r.sentTo("c-host", "screen.viewer")); got != 5 {
		t.Fatalf("broadcaster got %d viewer notices, want 5", got)
	}
	// Watching again from the same connection re-notifies, without a new slot.
	if err := r.watch("c-v1", "u-v1"); err != nil {
		t.Fatal(err)
	}
	if sc := r.screen(); sc.ViewerCount != 5 {
		t.Fatalf("re-watch changed viewerCount to %d", sc.ViewerCount)
	}
	if got := testutil.ToFloat64(r.metrics.ScreenWatchRejects.WithLabelValues(screenRejectFull)); got != 1 {
		t.Fatalf("full rejections = %v, want 1", got)
	}
}

func TestScreenWatch_OneSlotPerPerson(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom("ana")
	r.start("c-host", "u-host")
	if err := r.watch("c-ana", "u-ana"); err != nil {
		t.Fatal(err)
	}
	// Ana opens a second tab: the slot moves, the count stays at one.
	r.join(screenRoom, "c-ana2", "u-ana")
	if err := r.watch("c-ana2", "u-ana"); err != nil {
		t.Fatal(err)
	}
	if sc := r.screen(); sc.ViewerCount != 1 {
		t.Fatalf("viewerCount = %d, want 1 (one slot per person)", sc.ViewerCount)
	}
	leaves := r.sentTo("c-ana", "screen.viewer")
	if len(leaves) != 1 || leaves[0]["action"] != "leave" || leaves[0]["clientId"] != "c-ana" {
		t.Fatalf("old tab notices = %v, want one leave for itself", leaves)
	}
}

func TestScreenLockAndRefuse(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom("ana", "bia", "caio")
	r.start("c-host", "u-host")
	if err := r.watch("c-ana", "u-ana"); err != nil {
		t.Fatal(err)
	}

	// Refuse Ana: her slot goes and she cannot come back this session.
	r.mustCall("c-host", "u-host", "screen.refuse", map[string]any{"roomId": screenRoom, "clientId": "c-ana"})
	if sc := r.screen(); sc.ViewerCount != 0 {
		t.Fatalf("viewerCount after refuse = %d, want 0", sc.ViewerCount)
	}
	wantUserError(t, r.watch("c-ana", "u-ana"), "não está aceitando")
	r.join(screenRoom, "c-ana2", "u-ana") // a second tab is the same person
	wantUserError(t, r.watch("c-ana2", "u-ana"), "não está aceitando")

	// A non-host member cannot lock.
	_, err := r.call("c-bia", "u-bia", "screen.lock", map[string]any{"roomId": screenRoom, "locked": true})
	wantUserError(t, err, "host")
	// Lock: Bia is refused, an admitted viewer would stay.
	if err := r.watch("c-caio", "u-caio"); err != nil {
		t.Fatal(err)
	}
	r.mustCall("c-host", "u-host", "screen.lock", map[string]any{"roomId": screenRoom, "locked": true})
	wantUserError(t, r.watch("c-bia", "u-bia"), "não está aceitando")
	if sc := r.screen(); !sc.Locked || sc.ViewerCount != 1 {
		t.Fatalf("after lock screen = %+v, want locked with Caio still in", sc)
	}
	// Unwatch is always allowed, and a no-op for a non-viewer.
	r.mustCall("c-caio", "u-caio", "screen.unwatch", map[string]any{"roomId": screenRoom})
	r.mustCall("c-bia", "u-bia", "screen.unwatch", map[string]any{"roomId": screenRoom})
	if sc := r.screen(); sc.ViewerCount != 0 {
		t.Fatalf("viewerCount after unwatch = %d", sc.ViewerCount)
	}
	if got := r.auditActions(); fmt.Sprint(got) != fmt.Sprint([]string{"screen.start", "screen.refuse"}) {
		t.Fatalf("trail = %v", got)
	}
}

// signal relays one rtc.signal call.
func (r *screenRig) signal(from, fromUser, to string, payload map[string]any) error {
	_, err := r.call(from, fromUser, "rtc.signal", map[string]any{"roomId": screenRoom, "to": to, "payload": payload})
	return err
}

func TestRTCSignal_RelaysTheAdmittedPair(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom("ana")
	r.start("c-host", "u-host")
	if err := r.watch("c-ana", "u-ana"); err != nil {
		t.Fatal(err)
	}
	offer := map[string]any{"kind": "offer", "sdp": "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n"}
	if err := r.signal("c-host", "u-host", "c-ana", offer); err != nil {
		t.Fatalf("offer: %v", err)
	}
	answer := map[string]any{"kind": "answer", "sdp": "v=0\r\n"}
	if err := r.signal("c-ana", "u-ana", "c-host", answer); err != nil {
		t.Fatalf("answer: %v", err)
	}
	cands := map[string]any{"kind": "candidates", "candidates": []any{map[string]any{"candidate": "candidate:1 1 udp 1 127.0.0.1 5000 typ host", "sdpMid": "0", "sdpMLineIndex": 0}}}
	if err := r.signal("c-ana", "u-ana", "c-host", cands); err != nil {
		t.Fatalf("candidates: %v", err)
	}
	for _, p := range []map[string]any{{"kind": "end-of-candidates"}, {"kind": "bye"}} {
		if err := r.signal("c-host", "u-host", "c-ana", p); err != nil {
			t.Fatalf("%v: %v", p["kind"], err)
		}
	}
	got := r.sentTo("c-ana", "rtc.signal")
	if len(got) != 3 {
		t.Fatalf("viewer received %d signals, want 3", len(got))
	}
	if got[0]["from"] != "c-host" || got[0]["roomId"] != screenRoom {
		t.Fatalf("relayed signal = %v, want from stamped as c-host", got[0])
	}
	if p := got[0]["payload"].(map[string]any); p["sdp"] != offer["sdp"] || p["kind"] != "offer" {
		t.Fatalf("relayed payload = %v", p)
	}
}

func TestRTCSignal_Refusals(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom("ana", "bia", "caio")
	offer := map[string]any{"kind": "offer", "sdp": "v=0\r\n"}

	wantUserError(t, r.signal("c-host", "u-host", "c-ana", offer), "Ninguém está compartilhando")

	r.start("c-host", "u-host")
	for _, v := range []string{"ana", "bia"} {
		if err := r.watch("c-"+v, "u-"+v); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		name, from, fromUser, to string
		payload                  map[string]any
		want                     string
	}{
		{"viewer to viewer", "c-ana", "u-ana", "c-bia", map[string]any{"kind": "bye"}, "not allowed"},
		{"to a member who did not watch", "c-host", "u-host", "c-caio", offer, "not allowed"},
		{"from a member who did not watch", "c-caio", "u-caio", "c-host", map[string]any{"kind": "bye"}, "not allowed"},
		{"offer from a viewer", "c-ana", "u-ana", "c-host", offer, "only the broadcaster"},
		{"answer from the broadcaster", "c-host", "u-host", "c-ana", map[string]any{"kind": "answer", "sdp": "v=0\r\n"}, "only viewers"},
		{"unknown kind", "c-host", "u-host", "c-ana", map[string]any{"kind": "chat", "text": "hi"}, "invalid signal"},
		{"extra field", "c-host", "u-host", "c-ana", map[string]any{"kind": "offer", "sdp": "v=0\r\n", "from": "c-bia"}, "invalid signal"},
		{"not SDP", "c-host", "u-host", "c-ana", map[string]any{"kind": "offer", "sdp": "hello"}, "invalid signal"},
		{"too many candidates", "c-host", "u-host", "c-ana", map[string]any{"kind": "candidates", "candidates": make([]any, rtcMaxCandidates+1)}, "invalid signal"},
		{"oversized", "c-host", "u-host", "c-ana", map[string]any{"kind": "offer", "sdp": "v=0" + strings.Repeat("a", rtcSignalMaxBytes)}, "too large"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wantUserError(t, r.signal(tc.from, tc.fromUser, tc.to, tc.payload), tc.want)
		})
	}
	// A forged sender field at the top level is refused, never trusted.
	_, err := r.call("c-ana", "u-ana", "rtc.signal", map[string]any{"roomId": screenRoom, "to": "c-host", "from": "c-bia", "payload": map[string]any{"kind": "bye"}})
	wantUserError(t, err, "invalid signal")
	if got := r.sentTo("c-bia", "rtc.signal"); len(got) != 0 {
		t.Fatalf("a refused signal reached a member: %v", got)
	}
}

func TestRTCSignal_RateLimited(t *testing.T) {
	r := newScreenRig(t)
	r.h.rtcLimiter = newRateLimiter(3, time.Hour, time.Now)
	r.hostRoom("ana")
	r.start("c-host", "u-host")
	if err := r.watch("c-ana", "u-ana"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := r.signal("c-host", "u-host", "c-ana", map[string]any{"kind": "end-of-candidates"}); err != nil {
			t.Fatalf("signal %d: %v", i, err)
		}
	}
	wantUserError(t, r.signal("c-host", "u-host", "c-ana", map[string]any{"kind": "end-of-candidates"}), "too many requests")
}

// The default bucket admits the broadcaster side of five simultaneous joins.
func TestRTCSignal_DefaultBucketCoversFiveJoins(t *testing.T) {
	r := newScreenRig(t)
	viewers := []string{"v1", "v2", "v3", "v4", "v5"}
	r.hostRoom(viewers...)
	r.start("c-host", "u-host")
	for _, v := range viewers {
		if err := r.watch("c-"+v, "u-"+v); err != nil {
			t.Fatal(err)
		}
	}
	cand := map[string]any{"kind": "candidates", "candidates": []any{map[string]any{"candidate": "candidate:1 1 udp 1 127.0.0.1 5000 typ host"}}}
	for _, v := range viewers {
		msgs := []map[string]any{{"kind": "offer", "sdp": "v=0\r\n"}, cand, cand, cand, cand, cand, {"kind": "end-of-candidates"}}
		for _, m := range msgs {
			if err := r.signal("c-host", "u-host", "c-"+v, m); err != nil {
				t.Fatalf("join burst to %s: %v", v, err)
			}
		}
	}
}

func TestRTCSignal_VanishedTargetFreesTheSlot(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom("ana")
	r.start("c-host", "u-host")
	if err := r.watch("c-ana", "u-ana"); err != nil {
		t.Fatal(err)
	}
	r.mu.Lock()
	r.gone["c-ana"] = true
	r.mu.Unlock()
	wantUserError(t, r.signal("c-host", "u-host", "c-ana", map[string]any{"kind": "offer", "sdp": "v=0\r\n"}), "não está mais conectada")
	if sc := r.screen(); sc.ViewerCount != 0 {
		t.Fatalf("viewerCount = %d, want the vanished viewer's slot freed", sc.ViewerCount)
	}
}

// publishCounter counts publications that drop a live share.
func countScreenEnds(t *testing.T, h *Hub) *int {
	t.Helper()
	n := 0
	var mu sync.Mutex
	live := false
	h.publishFn = func(roomID string, state json.RawMessage) error {
		var st queue.RoomState
		if err := json.Unmarshal(state, &st); err != nil {
			t.Fatal(err)
		}
		mu.Lock()
		defer mu.Unlock()
		if live && st.Screen == nil {
			n++
		}
		live = st.Screen != nil
		return nil
	}
	return &n
}

// Kick regression (spec section 3): roomKick drops membership before the
// disconnect runs, so the share must end inside roomKick, and the
// OnDisconnect replay afterwards must be a no-op.
func TestScreen_KickedBroadcasterEndsShareOnce(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom("ana")
	r.mustCall("c-host", "u-host", "room.transfer_host", map[string]any{"roomId": screenRoom, "userId": "u-ana"})
	r.start("c-ana", "u-ana")
	r.mustCall("c-ana", "u-ana", "room.transfer_host", map[string]any{"roomId": screenRoom, "userId": "u-host"})
	ends := countScreenEnds(t, r.h)
	r.start("c-ana", "u-ana") // idempotent re-start: publishes nothing
	r.mustCall("c-ana", "u-ana", "screen.lock", map[string]any{"roomId": screenRoom, "locked": true})

	r.mustCall("c-host", "u-host", "room.kick", map[string]any{"roomId": screenRoom, "clientId": "c-ana"})
	// Replay the OnDisconnect sequence the real disconnect would run.
	r.h.ScreenOnDisconnect("c-ana")
	r.h.PromoteOnDisconnect("c-ana")
	r.h.Leave("c-ana")
	r.h.RemoveClientUserID("c-ana")

	if r.screen() != nil {
		t.Fatal("share still live after the broadcaster was kicked")
	}
	if *ends != 1 {
		t.Fatalf("share-ending publications = %d, want exactly 1", *ends)
	}
	if got := testutil.ToFloat64(r.metrics.ScreenSessionsEnded.WithLabelValues(screenEndKicked)); got != 1 {
		t.Fatalf("kicked ends = %v, want 1", got)
	}
}

func TestScreen_KickedViewerFreesSlotAndNotifies(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom("ana")
	r.start("c-host", "u-host")
	if err := r.watch("c-ana", "u-ana"); err != nil {
		t.Fatal(err)
	}
	r.mustCall("c-host", "u-host", "room.kick", map[string]any{"roomId": screenRoom, "clientId": "c-ana"})
	r.h.ScreenOnDisconnect("c-ana")
	if sc := r.screen(); sc == nil || sc.ViewerCount != 0 {
		t.Fatalf("screen after viewer kick = %+v, want live with 0 viewers", sc)
	}
	notices := r.sentTo("c-host", "screen.viewer")
	last := notices[len(notices)-1]
	if last["action"] != "leave" || last["clientId"] != "c-ana" {
		t.Fatalf("last broadcaster notice = %v, want leave c-ana", last)
	}
}

// ScreenOnDisconnect resolves rooms from its own index: membership already
// cleared (the rebind zombie path, a kick) must still end the share.
func TestScreenOnDisconnect_UsesItsOwnIndex(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom()
	r.start("c-host", "u-host")
	r.h.leaveRoom("c-host", screenRoom)
	r.h.ScreenOnDisconnect("c-host")
	if r.screen() != nil {
		t.Fatal("share survived a disconnect after membership was cleared")
	}
	if got := testutil.ToFloat64(r.metrics.ScreenSessionsEnded.WithLabelValues(screenEndDisconnect)); got != 1 {
		t.Fatalf("disconnect ends = %v, want 1", got)
	}
}

func TestScreen_OperatorCloseEndsShare(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom()
	r.start("c-host", "u-host")
	r.h.SetClosedRooms([]string{screenRoom})
	if got := testutil.ToFloat64(r.metrics.ScreenSessionsEnded.WithLabelValues(screenEndClosed)); got != 1 {
		t.Fatalf("closed ends = %v, want 1", got)
	}
	r.h.ScreenOnDisconnect("c-host") // the room is gone: must not reload it
	r.h.mu.RLock()
	_, resident := r.h.rooms[screenRoom]
	r.h.mu.RUnlock()
	if resident {
		t.Fatal("cleanup resurrected a closed room")
	}
}

func TestScreen_ShutdownEndsInPlace(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom()
	r.start("c-host", "u-host")
	r.h.BeginShutdown()
	r.h.ScreenOnDisconnect("c-host")
	if got := testutil.ToFloat64(r.metrics.ScreenSessionsEnded.WithLabelValues(screenEndShutdown)); got != 1 {
		t.Fatalf("shutdown ends = %v, want 1", got)
	}
}

// screenSaveStore records every state the hub saves.
type screenSaveStore struct {
	*store.Memory
	mu    sync.Mutex
	saved []*queue.RoomState
}

func (s *screenSaveStore) Save(ctx context.Context, st *queue.RoomState) error {
	s.mu.Lock()
	cp := *st
	s.saved = append(s.saved, &cp)
	s.mu.Unlock()
	return s.Memory.Save(ctx, st)
}

func TestScreen_NeverPersisted(t *testing.T) {
	r := newScreenRig(t)
	st := &screenSaveStore{Memory: store.NewMemory()}
	r.h.WithStore(st)
	r.hostRoom("ana")
	r.start("c-host", "u-host")
	if err := r.watch("c-ana", "u-ana"); err != nil {
		t.Fatal(err)
	}
	st.mu.Lock()
	for i, s := range st.saved {
		if s.Screen != nil {
			t.Fatalf("save %d carried a screen share: %+v", i, s.Screen)
		}
	}
	st.mu.Unlock()

	// A stored row carrying a share (a bug elsewhere) is cleared on load.
	_ = st.Memory.Save(context.Background(), &queue.RoomState{RoomID: "ZZZZZZZZZZZZ", Screen: &queue.ScreenShareState{BroadcasterID: "ghost"}})
	room, err := r.h.GetOrCreateRoom("ZZZZZZZZZZZZ")
	if err != nil {
		t.Fatal(err)
	}
	if room.State.Screen != nil {
		t.Fatal("load kept a persisted screen share")
	}
}

func TestScreenConfig_NeedsRoomAuthEverywhere(t *testing.T) {
	// Tested here through the hub's contract; the boot check itself lives in
	// cmd/server (screenShareConfigError) and is tested there.
	h := NewHub(nil).WithScreenShare(true, []string{"", "  "})
	if h.screen.allowlist != nil {
		t.Fatalf("blank allowlist entries must mean no allowlist, got %v", h.screen.allowlist)
	}
}

// Review finding: a broadcaster who lost the host role keeps the running
// share but cannot open a fresh one from another tab.
func TestScreenStart_DemotedBroadcasterCannotTakeOver(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom("ana")
	r.mustCall("c-host", "u-host", "room.transfer_host", map[string]any{"roomId": screenRoom, "userId": "u-ana"})
	r.start("c-ana", "u-ana")
	r.mustCall("c-ana", "u-ana", "room.transfer_host", map[string]any{"roomId": screenRoom, "userId": "u-host"})
	r.join(screenRoom, "c-ana2", "u-ana")
	_, err := r.call("c-ana2", "u-ana", "screen.start", map[string]any{"roomId": screenRoom, "ageAffirmed": true})
	wantUserError(t, err, "host")
	if sc := r.screen(); sc == nil || sc.BroadcasterID != "c-ana" {
		t.Fatalf("running share changed: %+v", sc)
	}
}

func TestScreen_EndNoticesReachEveryConnection(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom("ana")
	r.start("c-host", "u-host")
	if err := r.watch("c-ana", "u-ana"); err != nil {
		t.Fatal(err)
	}
	r.join(screenRoom, "c-host2", "u-host")
	r.start("c-host2", "u-host") // takeover ends the first session
	for _, c := range []string{"c-host", "c-ana"} {
		if got := r.sentTo(c, "screen.ended"); len(got) != 1 {
			t.Fatalf("%s got %d screen.ended notices, want 1", c, len(got))
		}
	}
}

func TestScreenRefuse_TargetMustBeInTheRoom(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom()
	r.start("c-host", "u-host")
	_, err := r.call("c-host", "u-host", "screen.refuse", map[string]any{"roomId": screenRoom, "clientId": "c-nobody"})
	wantUserError(t, err, "not in this room")
	_, err = r.call("c-host", "u-host", "screen.refuse", map[string]any{"roomId": screenRoom, "clientId": "c-host"})
	wantUserError(t, err, "parar")
}

// A refused member who is not watching is still refused by identity.
func TestScreenRefuse_NonViewerByIdentity(t *testing.T) {
	r := newScreenRig(t)
	r.hostRoom("ana")
	r.start("c-host", "u-host")
	r.mustCall("c-host", "u-host", "screen.refuse", map[string]any{"roomId": screenRoom, "clientId": "c-ana"})
	r.join(screenRoom, "c-ana2", "u-ana")
	wantUserError(t, r.watch("c-ana2", "u-ana"), "não está aceitando")
}
