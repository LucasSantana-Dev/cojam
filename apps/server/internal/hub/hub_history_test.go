package hub

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
	"github.com/LucasSantana-Dev/cojam/server/internal/store"
)

func historyAdd(t *testing.T, h *Hub, title string) {
	t.Helper()
	body := `{"roomId":"` + rolesRoom + `","track":{"title":"` + title + `","artist":"A","sources":{},"addedBy":"x"}}`
	if err := rolesRPC(h, "queue.add", body, "c-o", "owner"); err != nil {
		t.Fatalf("queue.add %s: %v", title, err)
	}
}

func TestHistory_ReAddRPC_ControllersOnlyNewIDKeepsHistory(t *testing.T) {
	h := NewHub(nil)
	rolesJoin(t, h, "c-o", "owner")
	rolesJoin(t, h, "c-b", "bob")
	historyAdd(t, h, "one")
	historyAdd(t, h, "two")

	first := rolesState(t, h).Queue[0].ID
	if err := rolesRPC(h, "now_playing.advance", `{"roomId":"`+rolesRoom+`","afterId":"`+first+`"}`, "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	st := rolesState(t, h)
	if len(st.History) != 1 || st.History[0].ID != first {
		t.Fatalf("history after advance: %+v", st.History)
	}

	body := `{"roomId":"` + rolesRoom + `","trackId":"` + first + `"}`
	// a plain member is refused before dispatch
	if err := h.Authorize(newTestClient("c-b", "bob"), "history.readd", []byte(body)); err == nil {
		t.Fatal("a plain member must not re-add from history")
	}
	if err := h.Authorize(newTestClient("c-o", "owner"), "history.readd", []byte(body)); err != nil {
		t.Fatalf("host must be allowed: %v", err)
	}

	if err := rolesRPC(h, "history.readd", body, "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	st = rolesState(t, h)
	if len(st.Queue) != 2 {
		t.Fatalf("queue len %d, want 2", len(st.Queue))
	}
	last := st.Queue[len(st.Queue)-1]
	if last.Title != "one" || last.ID == first {
		t.Fatalf("re-added entry must be new and last: %+v", last)
	}
	if st.NowPlayingID == last.ID {
		t.Fatal("re-add must not change now playing")
	}
	if len(st.History) != 1 || st.History[0].ID != first {
		t.Fatalf("history must be untouched: %+v", st.History)
	}

	err := rolesRPC(h, "history.readd", `{"roomId":"`+rolesRoom+`","trackId":"missing"}`, "c-o", "owner")
	if err == nil || !isUserError(err) {
		t.Fatalf("unknown history id: got %v, want UserError", err)
	}
}

func TestHistory_AutoSkipSourcelessGoesToHistory(t *testing.T) {
	h := NewHub(nil)
	rolesJoin(t, h, "c-o", "owner")
	historyAdd(t, h, "one")
	historyAdd(t, h, "two")
	first := rolesState(t, h).Queue[0].ID
	// the sourceless auto skip advances with withSkipCheck=false
	if _, err := h.advanceAfter(rolesRoom, first, false); err != nil {
		t.Fatal(err)
	}
	st := rolesState(t, h)
	if len(st.History) != 1 || st.History[0].Title != "one" || len(st.Queue) != 1 {
		t.Fatalf("queue=%d history=%+v", len(st.Queue), st.History)
	}
}

func TestHistory_RadioSeedsFromLastPlayed(t *testing.T) {
	h := NewHub(nil)
	seed := make(chan [2]string, 1)
	h.WithSimilarProvider(func(_ context.Context, artist, title string, _ int) ([]queue.TrackRef, error) {
		seed <- [2]string{artist, title}
		return nil, nil
	})
	rolesJoin(t, h, "c-o", "owner")
	historyAdd(t, h, "only")
	if err := rolesRPC(h, "radio.set", `{"roomId":"`+rolesRoom+`","enabled":true}`, "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	only := rolesState(t, h).Queue[0].ID
	if err := rolesRPC(h, "now_playing.advance", `{"roomId":"`+rolesRoom+`","afterId":"`+only+`"}`, "c-o", "owner"); err != nil {
		t.Fatal(err)
	}
	if got := <-seed; got != [2]string{"A", "only"} {
		t.Fatalf("seed %v, want History[0]", got)
	}
}

// An existing prod room persisted in the old shape (played tracks stay in the
// queue) is migrated on load, with no manual SQL.
func TestHistory_LegacyRoomMigratedOnLoad(t *testing.T) {
	legacy := `{"roomId":"OLD1","queue":[
		{"id":"p1","title":"Played 1","artist":"A","sources":{},"addedBy":"u"},
		{"id":"p2","title":"Played 2","artist":"A","sources":{},"addedBy":"u"},
		{"id":"cur","title":"Now","artist":"A","sources":{},"addedBy":"u"},
		{"id":"nx","title":"Next","artist":"A","sources":{},"addedBy":"u"}],
		"nowPlayingId":"cur","radioEnabled":false,"version":9}`
	var st queue.RoomState
	if err := json.Unmarshal([]byte(legacy), &st); err != nil {
		t.Fatal(err)
	}
	mem := store.NewMemory()
	if err := mem.Save(context.Background(), &st); err != nil {
		t.Fatal(err)
	}
	h := NewHub(nil).WithStore(mem)
	room := mustRoom(t, h, "OLD1")
	room.mu.Lock()
	defer room.mu.Unlock()
	got := room.State
	if len(got.Queue) != 2 || got.Queue[0].ID != "cur" || got.Queue[1].ID != "nx" {
		t.Fatalf("queue=%+v", got.Queue)
	}
	if len(got.History) != 2 || got.History[0].ID != "p2" || got.History[1].ID != "p1" {
		t.Fatalf("history=%+v (newest first)", got.History)
	}
	if got.NowPlayingID != "cur" {
		t.Fatalf("nowPlayingId changed: %s", got.NowPlayingID)
	}
}
