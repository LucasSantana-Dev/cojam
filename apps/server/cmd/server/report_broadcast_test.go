package main

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/hub"
	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
	"github.com/LucasSantana-Dev/cojam/server/internal/report"
)

// A broadcast report (#310) names no subject and copies no content: the
// server resolves who was broadcasting, and the report is never rejected.
func TestReport_BroadcastSubjectComesFromTheServer(t *testing.T) {
	store := report.NewMemory()
	audit := report.NewMemoryAudit()
	now := time.Now().UTC()
	const liveRoom, pastRoom, emptyRoom = "LIVEROOM0001", "PASTROOM0001", "NONEROOM0001"
	live := func(roomID, kind, subjectID string) hub.Subject {
		if roomID == liveRoom {
			return hub.Subject{Sub: "sub-live", Name: "Ana", Text: `{"live":true}`}
		}
		return hub.Subject{}
	}
	_ = audit.Record(context.Background(), report.Action{ID: "x", RoomID: pastRoom, Action: "screen.stop",
		SubjectID: "sub-past", Detail: map[string]any{"name": "Bia"}, CreatedAt: now.Add(-6 * 24 * time.Hour)})
	h := reportHandler(store, testRoomSecret, obs.New(), quietLogger(),
		newCallerLimiter(100, time.Millisecond), nil, broadcastSubjects(live, audit, quietLogger(), time.Now))

	for _, body := range []string{
		`{"roomId":"` + liveRoom + `","kind":"broadcast","subjectId":"someone-else","content":"forged","reason":"r"}`,
		`{"roomId":"` + pastRoom + `","kind":"broadcast","reason":"r"}`,
		`{"roomId":"` + emptyRoom + `","kind":"broadcast","reason":"r"}`,
	} {
		if rec := postReport(h, body); rec.Code != http.StatusNoContent {
			t.Fatalf("body %s: got %d, want 204 (broadcast reports are never rejected)", body, rec.Code)
		}
	}
	got, _ := store.Recent(context.Background(), 10)
	byRoom := map[string]report.Report{}
	for _, r := range got {
		byRoom[r.RoomID] = r
	}
	if r := byRoom[liveRoom]; r.SubjectSub != "sub-live" || r.SubjectID != "" || r.Content != `{"live":true}` {
		t.Fatalf("live broadcast report = %+v, want the server's subject and session, not the reporter's", r)
	}
	if r := byRoom[pastRoom]; r.SubjectSub != "sub-past" || r.SubjectName != "Bia" {
		t.Fatalf("ended broadcast report = %+v, want the trail's subject", r)
	}
	if r := byRoom[emptyRoom]; r.SubjectSub != "" || r.Reason != "r" {
		t.Fatalf("unattributable broadcast report = %+v, want stored with an empty subject", r)
	}
}
