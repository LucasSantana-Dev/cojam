package queue

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func roomWith(titles ...string) *RoomState {
	rs := &RoomState{RoomID: "r"}
	for _, t := range titles {
		rs.Add(TrackRef{Title: t, Artist: "A", AddedBy: "u"})
	}
	return rs
}

func queueTitles(rs *RoomState) []string {
	out := make([]string, len(rs.Queue))
	for i, t := range rs.Queue {
		out[i] = t.Title
	}
	return out
}

func historyTitles(rs *RoomState) []string {
	out := make([]string, len(rs.History))
	for i, h := range rs.History {
		out[i] = h.Title
	}
	return out
}

func eq(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestHistory_AdvanceMovesOutgoingToHistory(t *testing.T) {
	rs := roomWith("a", "b", "c")
	if err := rs.AdvanceAfter(rs.NowPlayingID); err != nil {
		t.Fatal(err)
	}
	if !eq(queueTitles(rs), []string{"b", "c"}) || !eq(historyTitles(rs), []string{"a"}) {
		t.Fatalf("queue=%v history=%v", queueTitles(rs), historyTitles(rs))
	}
	if rs.Queue[0].ID != rs.NowPlayingID {
		t.Fatal("playing track must be the head")
	}
	if rs.History[0].PlayedAt == 0 {
		t.Fatal("playedAt must be stamped")
	}
}

func TestHistory_SetNowPlayingJumpsAndRetiresOutgoing(t *testing.T) {
	rs := roomWith("a", "b", "c")
	if err := rs.SetNowPlaying(rs.Queue[2].ID); err != nil {
		t.Fatal(err)
	}
	if !eq(queueTitles(rs), []string{"c", "b"}) || !eq(historyTitles(rs), []string{"a"}) {
		t.Fatalf("queue=%v history=%v", queueTitles(rs), historyTitles(rs))
	}
}

func TestHistory_SetNowPlayingSameTrackKeepsHistory(t *testing.T) {
	rs := roomWith("a", "b")
	if err := rs.SetNowPlaying(rs.NowPlayingID); err != nil {
		t.Fatal(err)
	}
	if len(rs.History) != 0 || len(rs.Queue) != 2 {
		t.Fatalf("queue=%v history=%v", queueTitles(rs), historyTitles(rs))
	}
}

func TestHistory_RemoveNowPlayingGoesToHistory(t *testing.T) {
	rs := roomWith("a", "b")
	if err := rs.Remove(rs.NowPlayingID); err != nil {
		t.Fatal(err)
	}
	if !eq(historyTitles(rs), []string{"a"}) || rs.Queue[0].ID != rs.NowPlayingID {
		t.Fatalf("queue=%v history=%v", queueTitles(rs), historyTitles(rs))
	}
}

func TestHistory_RemoveUpcomingDoesNotTouchHistory(t *testing.T) {
	rs := roomWith("a", "b")
	if err := rs.Remove(rs.Queue[1].ID); err != nil {
		t.Fatal(err)
	}
	if len(rs.History) != 0 {
		t.Fatalf("history=%v", historyTitles(rs))
	}
}

func TestHistory_FinishingLastTrackLeavesQueueEmpty(t *testing.T) {
	rs := roomWith("a")
	_ = rs.AdvanceAfter(rs.NowPlayingID)
	if len(rs.Queue) != 0 || rs.NowPlayingID != "" || len(rs.History) != 1 {
		t.Fatalf("queue=%v np=%q history=%v", queueTitles(rs), rs.NowPlayingID, historyTitles(rs))
	}
	// A new track into the drained room plays, and the played one never returns.
	added := rs.Add(TrackRef{Title: "n"})
	if rs.NowPlayingID != added.ID || len(rs.Queue) != 1 {
		t.Fatalf("np=%q queue=%v", rs.NowPlayingID, queueTitles(rs))
	}
}

// The bug: a vote reorder or a play jump let played tracks come back around.
func TestHistory_VoteReorderNeverReplaysPlayed(t *testing.T) {
	rs := roomWith("a", "b", "c", "d")
	_ = rs.AdvanceAfter(rs.NowPlayingID) // a played
	_, _ = rs.ToggleVote(rs.Queue[2].ID, "voter-1")
	// the host pushes the voted track d to the top of the upcoming list
	if err := rs.Move(rs.Queue[2].ID, 0); err != nil {
		t.Fatal(err)
	}
	var played []string
	for rs.NowPlayingID != "" {
		played = append(played, rs.Track(rs.NowPlayingID).Title)
		_ = rs.AdvanceAfter(rs.NowPlayingID)
	}
	if !eq(played, []string{"b", "d", "c"}) {
		t.Fatalf("playback order %v: a must not repeat, d goes right after b", played)
	}
	seen := map[string]int{}
	for _, h := range rs.History {
		seen[h.Title]++
	}
	for title, n := range seen {
		if n != 1 {
			t.Fatalf("%s appears %d times in history", title, n)
		}
	}
}

func TestHistory_VotesAndReorderDoNotTouchHistory(t *testing.T) {
	rs := roomWith("a", "b", "c")
	_ = rs.AdvanceAfter(rs.NowPlayingID)
	before := append([]HistoryEntry(nil), rs.History...)
	_, _ = rs.ToggleVote(rs.Queue[1].ID, "voter-1")
	_ = rs.Move(rs.Queue[1].ID, 1)
	_ = rs.Remove(rs.Queue[1].ID)
	if len(rs.History) != len(before) || rs.History[0].ID != before[0].ID {
		t.Fatalf("history changed: %v", historyTitles(rs))
	}
}

func TestHistory_PlayedTrackCannotBeSet(t *testing.T) {
	rs := roomWith("a", "b")
	old := rs.NowPlayingID
	_ = rs.AdvanceAfter(old)
	if err := rs.SetNowPlaying(old); err == nil {
		t.Fatal("a played track is no longer in the queue and cannot be set")
	}
}

func TestHistory_Cap(t *testing.T) {
	rs := &RoomState{RoomID: "r"}
	n := MaxHistory + 10
	for i := 0; i < n; i++ {
		rs.Add(TrackRef{Title: fmt.Sprintf("t%d", i)})
	}
	for rs.NowPlayingID != "" {
		_ = rs.AdvanceAfter(rs.NowPlayingID)
	}
	if len(rs.History) != MaxHistory {
		t.Fatalf("history len %d, want %d", len(rs.History), MaxHistory)
	}
	if rs.History[0].Title != fmt.Sprintf("t%d", n-1) {
		t.Fatalf("newest first: got %s", rs.History[0].Title)
	}
}

func TestHistory_ReAddCreatesNewEntryAndKeepsHistory(t *testing.T) {
	rs := roomWith("a", "b")
	rs.Queue[0].Sources.YouTube = &SourceRef{VideoID: "vid", Confidence: 1}
	oldID := rs.NowPlayingID
	_ = rs.AdvanceAfter(oldID)

	added, err := rs.ReAddFromHistory(oldID, "Zed", "uid-z")
	if err != nil {
		t.Fatal(err)
	}
	if added.ID == oldID || added.ID == "" {
		t.Fatalf("re-add must mint a new id, got %q", added.ID)
	}
	if rs.Queue[len(rs.Queue)-1].ID != added.ID {
		t.Fatal("re-added track goes to the end")
	}
	if added.Title != "a" || added.Sources.YouTube == nil || added.AddedBy != "Zed" || added.AddedByUserID != "uid-z" {
		t.Fatalf("copied fields wrong: %+v", added)
	}
	if rs.Track(oldID) != nil {
		t.Fatal("old entry must not be resurrected in Queue")
	}
	if len(rs.History) != 1 || rs.History[0].ID != oldID {
		t.Fatal("history entry stays")
	}
	if rs.NowPlayingID == added.ID {
		t.Fatal("re-add must not hijack now playing")
	}
	if _, err := rs.ReAddFromHistory("nope", "", ""); err == nil {
		t.Fatal("unknown history id must fail")
	}
}

func TestMigrateLegacy_MovesPlayedBeforeIndexInPlayedOrder(t *testing.T) {
	// Old shape: played tracks stay in the queue behind the pointer.
	rs := &RoomState{
		RoomID: "r",
		Queue: []TrackRef{
			{ID: "1", Title: "one"}, {ID: "2", Title: "two"}, {ID: "3", Title: "three"},
			{ID: "4", Title: "four"}, {ID: "5", Title: "five"},
		},
		NowPlayingID: "4",
		Votes:        map[string][]string{"1": {"voter-1"}, "5": {"voter-2"}},
		Version:      7,
	}
	if !rs.MigrateLegacy() {
		t.Fatal("expected migration")
	}
	if !eq(queueTitles(rs), []string{"four", "five"}) {
		t.Fatalf("queue=%v", queueTitles(rs))
	}
	if !eq(historyTitles(rs), []string{"three", "two", "one"}) {
		t.Fatalf("history=%v (newest first)", historyTitles(rs))
	}
	if _, ok := rs.Votes["1"]; ok {
		t.Fatal("votes of migrated tracks must go")
	}
	if len(rs.Votes["5"]) != 1 {
		t.Fatal("upcoming votes stay")
	}
	if rs.MigrateLegacy() {
		t.Fatal("second run must be a no-op")
	}
}

func TestMigrateLegacy_DrainedRoomMovesEverything(t *testing.T) {
	rs := &RoomState{RoomID: "r", Queue: []TrackRef{{ID: "1", Title: "one"}, {ID: "2", Title: "two"}}}
	if !rs.MigrateLegacy() || len(rs.Queue) != 0 || !eq(historyTitles(rs), []string{"two", "one"}) {
		t.Fatalf("queue=%v history=%v", queueTitles(rs), historyTitles(rs))
	}
}

func TestMigrateLegacy_NewShapeAndDanglingAreUntouched(t *testing.T) {
	rs := roomWith("a", "b")
	if rs.MigrateLegacy() {
		t.Fatal("new shape must not migrate")
	}
	rs.NowPlayingID = "ghost"
	if rs.MigrateLegacy() || len(rs.Queue) != 2 {
		t.Fatal("dangling pointer must leave the queue alone")
	}
}

func TestMigrateLegacy_CapsHistory(t *testing.T) {
	rs := &RoomState{RoomID: "r"}
	for i := 0; i < MaxHistory+20; i++ {
		rs.Queue = append(rs.Queue, TrackRef{ID: fmt.Sprint(i), Title: fmt.Sprint(i)})
	}
	rs.Queue = append(rs.Queue, TrackRef{ID: "cur", Title: "cur"})
	rs.NowPlayingID = "cur"
	rs.MigrateLegacy()
	if len(rs.History) != MaxHistory || len(rs.Queue) != 1 {
		t.Fatalf("history=%d queue=%d", len(rs.History), len(rs.Queue))
	}
	if rs.History[0].Title != fmt.Sprint(MaxHistory+19) {
		t.Fatalf("newest first, got %s", rs.History[0].Title)
	}
}

func TestHistory_JSONShape(t *testing.T) {
	rs := roomWith("a", "b")
	if b, _ := json.Marshal(rs); strings.Contains(string(b), `"history"`) {
		t.Fatal("empty history is omitted")
	}
	_ = rs.AdvanceAfter(rs.NowPlayingID)
	b, _ := json.Marshal(rs)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	h := m["history"].([]any)[0].(map[string]any)
	for _, k := range []string{"id", "title", "artist", "addedBy", "playedAt"} {
		if _, ok := h[k]; !ok {
			t.Fatalf("history entry missing %s", k)
		}
	}
}
