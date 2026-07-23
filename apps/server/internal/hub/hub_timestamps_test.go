package hub

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// tsState is the JSON view of RoomState for timestamp assertions.
type tsState struct {
	CreatedAt int64 `json:"createdAt"`
	Queue     []struct {
		ID      string `json:"id"`
		AddedAt int64  `json:"addedAt"`
	} `json:"queue"`
	Version int64 `json:"version"`
}

// tsAdd queues a track (extraTrackJSON injects raw track fields) and returns
// the parsed room state after the add.
func tsAdd(t *testing.T, h *Hub, roomID, extraTrackJSON string) tsState {
	t.Helper()
	payload := fmt.Sprintf(`{"roomId":%q,"track":{"title":"Song","artist":"A","sources":{},"addedBy":"u"%s}}`,
		roomID, extraTrackJSON)
	res, err := h.HandleRPC("queue.add", []byte(payload), "")
	if err != nil {
		t.Fatalf("queue.add: %v", err)
	}
	var st tsState
	if err := json.Unmarshal(res, &st); err != nil {
		t.Fatalf("unmarshal add result: %v", err)
	}
	if len(st.Queue) == 0 {
		t.Fatal("queue.add result has empty queue")
	}
	return st
}

// The server stamps addedAt when a track enters the queue, and the usual
// Version bump still fires on every add.
func TestQueueAdd_StampsAddedAtAndBumpsVersion(t *testing.T) {
	h := NewHub(nil)

	before := time.Now().UnixMilli()
	first := tsAdd(t, h, "ts1", "")
	after := time.Now().UnixMilli()

	if got := first.Queue[len(first.Queue)-1].AddedAt; got < before || got > after {
		t.Fatalf("addedAt should be the server clock at add time: got %d, want within [%d, %d]", got, before, after)
	}
	if first.Version != 1 {
		t.Fatalf("first add must bump Version to 1: got %d", first.Version)
	}

	second := tsAdd(t, h, "ts1", "")
	if second.Version != first.Version+1 {
		t.Fatalf("second add must bump Version: got %d, want %d", second.Version, first.Version+1)
	}
	if got := second.Queue[len(second.Queue)-1].AddedAt; got < first.Queue[0].AddedAt {
		t.Fatalf("addedAt must be stamped per add: second add %d predates first %d", got, first.Queue[0].AddedAt)
	}
}

// A client-supplied addedAt is never trusted; the server overwrites it (same
// trust boundary as addedByUserId, B16).
func TestQueueAdd_ClientSuppliedAddedAtOverwritten(t *testing.T) {
	h := NewHub(nil)

	before := time.Now().UnixMilli()
	added := tsAdd(t, h, "ts2", `,"addedAt":1`)
	if got := added.Queue[len(added.Queue)-1].AddedAt; got < before {
		t.Fatalf("client-supplied addedAt must be overwritten with the server clock: got %d, want >= %d", got, before)
	}
}

// playlist.import stamps addedAt on every imported track (client-supplied
// values are overwritten too).
func TestPlaylistImport_StampsAddedAt(t *testing.T) {
	h := NewHub(nil)

	before := time.Now().UnixMilli()
	payload := []byte(`{"roomId":"ts3","url":"https://example.com/playlist","addedBy":"u","tracks":[{"title":"T1","artist":"A","sources":{},"addedAt":1},{"title":"T2","artist":"A","sources":{}}]}`)
	res, err := h.HandleRPC("playlist.import", payload, "")
	if err != nil {
		t.Fatalf("playlist.import: %v", err)
	}
	var st tsState
	if err := json.Unmarshal(res, &st); err != nil {
		t.Fatalf("unmarshal import result: %v", err)
	}
	if len(st.Queue) != 2 {
		t.Fatalf("expected 2 imported tracks, got %d", len(st.Queue))
	}
	for i, tr := range st.Queue {
		if tr.AddedAt < before {
			t.Fatalf("track %d addedAt must be server-stamped: got %d, want >= %d", i, tr.AddedAt, before)
		}
	}
	if st.Version != 2 {
		t.Fatalf("importing 2 tracks must bump Version twice: got %d", st.Version)
	}
}

// Fresh rooms get a server-stamped createdAt.
func TestRoomJoin_StampsCreatedAt(t *testing.T) {
	h := NewHub(nil)

	before := time.Now().UnixMilli()
	res, err := h.HandleRPC("room.join", []byte(`{"roomId":"ts4","name":"u"}`), "")
	if err != nil {
		t.Fatalf("room.join: %v", err)
	}
	after := time.Now().UnixMilli()

	var st tsState
	if err := json.Unmarshal(res, &st); err != nil {
		t.Fatalf("unmarshal join result: %v", err)
	}
	if st.CreatedAt < before || st.CreatedAt > after {
		t.Fatalf("createdAt should be the server clock at creation: got %d, want within [%d, %d]", st.CreatedAt, before, after)
	}
}
