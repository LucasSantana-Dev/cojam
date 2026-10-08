package hub

import (
	"encoding/json"
	"testing"
)

func clearBody() string { return `{"roomId":"` + rolesRoom + `"}` }

func clearSetup(t *testing.T) *Hub {
	t.Helper()
	h := NewHub(nil)
	rolesJoin(t, h, "c-o", "owner")
	rolesJoin(t, h, "c-b", "bob")
	return h
}

func TestQueueClear_ControllerGate(t *testing.T) {
	h := clearSetup(t)
	historyAdd(t, h, "one")
	historyAdd(t, h, "two")
	err := h.Authorize(newTestClient("c-b", "bob"), "queue.clear", []byte(clearBody()))
	wantErr := h.Authorize(newTestClient("c-b", "bob"), "queue.reorder", []byte(`{"roomId":"`+rolesRoom+`","trackId":"x","toIndex":1}`))
	if err == nil || wantErr == nil || err.Error() != wantErr.Error() {
		t.Fatalf("non-controller: got %v, want same as other control methods (%v)", err, wantErr)
	}
	if err := h.Authorize(newTestClient("c-o", "owner"), "queue.clear", []byte(clearBody())); err != nil {
		t.Fatalf("host must be allowed: %v", err)
	}
	if n := len(rolesState(t, h).Queue); n != 2 {
		t.Fatalf("queue changed by a refused call: %d", n)
	}
}

func TestQueueClear_KeepsHeadAndHistory(t *testing.T) {
	h := clearSetup(t)
	historyAdd(t, h, "one")
	historyAdd(t, h, "two")
	historyAdd(t, h, "three")
	first := rolesState(t, h).Queue[0].ID
	if err := rolesRPC(h, "now_playing.advance", `{"roomId":"`+rolesRoom+`","afterId":"`+first+`"}`, "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	before := rolesState(t, h)
	head := before.NowPlayingID
	res, err := h.handleRPC("queue.clear", []byte(clearBody()), "c-o", "owner")
	if err != nil {
		t.Fatal(err)
	}
	var out struct{ Removed int }
	if err := json.Unmarshal(res, &out); err != nil || out.Removed != 1 {
		t.Fatalf("result %s err %v, want removed 1", res, err)
	}
	st := rolesState(t, h)
	if len(st.Queue) != 1 || st.Queue[0].ID != head || st.NowPlayingID != head {
		t.Fatalf("head must stay: queue=%+v now=%s", st.Queue, st.NowPlayingID)
	}
	if len(st.History) != 1 || st.History[0].ID != first {
		t.Fatalf("history must be untouched: %+v", st.History)
	}
	if st.Version <= before.Version {
		t.Fatalf("version not bumped: %d -> %d", before.Version, st.Version)
	}
}

func TestQueueClear_DropsVotesOfRemoved(t *testing.T) {
	h := clearSetup(t)
	h.votingEnabled = true
	historyAdd(t, h, "one")
	historyAdd(t, h, "two")
	historyAdd(t, h, "three")
	st := rolesState(t, h)
	head, up := st.Queue[0].ID, st.Queue[1].ID
	for _, id := range []string{up, head} {
		if err := rolesRPC(h, "queue.vote", `{"roomId":"`+rolesRoom+`","trackId":"`+id+`"}`, "c-b", "bob"); err != nil {
			t.Fatalf("vote: %v", err)
		}
	}
	if err := rolesRPC(h, "queue.clear", clearBody(), "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	room := mustRoom(t, h, rolesRoom)
	room.mu.Lock()
	defer room.mu.Unlock()
	if _, ok := room.State.Votes[up]; ok {
		t.Fatal("votes of a removed track must go")
	}
	if len(room.State.Votes[head]) != 1 {
		t.Fatalf("votes of the head must stay: %+v", room.State.Votes)
	}
}

func TestQueueClear_EmptyIsNoop(t *testing.T) {
	h := clearSetup(t)
	before := rolesState(t, h).Version
	res, err := h.handleRPC("queue.clear", []byte(clearBody()), "c-o", "owner")
	if err != nil || string(res) != `{"removed":0}` {
		t.Fatalf("got %s, %v", res, err)
	}
	historyAdd(t, h, "only")
	v := rolesState(t, h).Version
	res, err = h.handleRPC("queue.clear", []byte(clearBody()), "c-o", "owner")
	if err != nil || string(res) != `{"removed":0}` {
		t.Fatalf("head only: got %s, %v", res, err)
	}
	if st := rolesState(t, h); st.Version != v || len(st.Queue) != 1 || before >= v {
		t.Fatalf("no-op must not bump version: %+v", st)
	}
}
