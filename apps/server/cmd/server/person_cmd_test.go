package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/centrifugal/centrifuge"

	"github.com/LucasSantana-Dev/cojam/server/internal/dbtest"
	"github.com/LucasSantana-Dev/cojam/server/internal/hub"
	"github.com/LucasSantana-Dev/cojam/server/internal/obs"
	"github.com/LucasSantana-Dev/cojam/server/internal/report"
)

// #259: the command refuses anything ambiguous before touching a database.
func TestRunPerson_RejectsBadInvocations(t *testing.T) {
	env := envOf(map[string]string{"DATABASE_URL": "postgres://unused/db"})
	for name, args := range map[string][]string{
		"no action":        {"--user", "sb:abc", "--dry-run"},
		"two actions":      {"--user", "sb:abc", "--block", "--unblock", "--apply"},
		"no mode":          {"--user", "sb:abc", "--block"},
		"both modes":       {"--user", "sb:abc", "--block", "--dry-run", "--apply"},
		"no person":        {"--block", "--apply"},
		"bad user":         {"--user", "sb:a b", "--block", "--apply"},
		"bad report":       {"--report", "rep 1", "--block", "--apply"},
		"list with action": {"--list", "--block"},
		"list with user":   {"--list", "--user", "sb:abc"},
		"stray positional": {"--user", "sb:abc", "--block", "--apply", "extra"},
		"unknown flag":     {"--user", "sb:abc", "--block", "--apply", "--force"},
	} {
		var out, errOut bytes.Buffer
		if code := runPerson(args, env, &out, &errOut); code != 2 {
			t.Errorf("%s: exit = %d, want 2 (stderr %q)", name, code, errOut.String())
		}
	}
	var out, errOut bytes.Buffer
	if code := runPerson([]string{"--list"}, envOf(nil), &out, &errOut); code != 2 ||
		!strings.Contains(errOut.String(), "DATABASE_URL") {
		t.Fatalf("missing DATABASE_URL: exit %d, stderr %q", code, errOut.String())
	}
}

// #259: the operator path end to end against the database. A dry run changes
// nothing; blocking from a report takes the identity the report recorded and
// puts the report's room under legal hold; a mismatched --user and a report
// with no identity are refused; unblock leaves the hold alone. Skips if
// TEST_DATABASE_URL is not set.
func TestRunPerson_BlockFromReport(t *testing.T) {
	pool := dbtest.Isolated(t)
	env := envOf(map[string]string{"DATABASE_URL": pool.Config().ConnString()})
	run := func(args ...string) (int, string, string) {
		var out, errOut bytes.Buffer
		code := runPerson(args, env, &out, &errOut)
		return code, out.String(), errOut.String()
	}
	ctx := context.Background()
	// rep-1 is consistent; rep-3 is about "Mallory" per the reporter but was
	// pointed at the connection of Bob, an innocent account.
	if _, err := pool.Exec(ctx, `INSERT INTO reports (id, room_id, kind, subject_id, subject_sub, subject_name, content) VALUES
		('rep-1', 'ROOM1', 'member', 'c-1', 'sb:abc', 'Ana', 'Ana'),
		('rep-2', 'ROOM2', 'room', '', '', '', ''),
		('rep-3', 'ROOM3', 'member', 'c-bob', 'sb:bob', 'Bob', 'Mallory')`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if code, out, _ := run("--report", "rep-1", "--block", "--dry-run"); code != 0 ||
		!strings.Contains(out, "person: sb:abc (account)") || !strings.Contains(out, "after:  blocked=true") ||
		!strings.Contains(out, "legal hold: room ROOM1") || !strings.Contains(out, "dry run") {
		t.Fatalf("dry run: exit %d, out %q", code, out)
	}
	if code, out, _ := run("--list"); code != 0 || !strings.Contains(out, "no one is blocked") {
		t.Fatalf("a dry run must change nothing: exit %d, out %q", code, out)
	}

	if code, _, errOut := run("--report", "rep-1", "--user", "sb:other", "--block", "--apply"); code != 2 ||
		!strings.Contains(errOut, "does not match") {
		t.Fatalf("mismatched --user: exit %d, err %q; want refusal", code, errOut)
	}
	if code, _, errOut := run("--report", "rep-2", "--block", "--apply"); code != 2 ||
		!strings.Contains(errOut, "pass --user") {
		t.Fatalf("report without identity: exit %d, err %q; want refusal", code, errOut)
	}
	if code, _, errOut := run("--report", "rep-3", "--block", "--apply"); code != 2 ||
		!strings.Contains(errOut, "does not match what the server saw") || !strings.Contains(errOut, `"Bob"`) {
		t.Fatalf("report aimed at someone else: exit %d, err %q; want refusal", code, errOut)
	}
	if code, out, _ := run("--list"); code != 0 || !strings.Contains(out, "no one is blocked") {
		t.Fatalf("a refused report must block no one: exit %d, out %q", code, out)
	}
	if code, _, errOut := run("--report", "rep-404", "--block", "--apply"); code != 2 ||
		!strings.Contains(errOut, "no report") {
		t.Fatalf("unknown report: exit %d, err %q; want refusal", code, errOut)
	}

	if code, out, errOut := run("--report", "rep-1", "--block", "--apply"); code != 0 ||
		!strings.Contains(out, "committed") || !strings.Contains(out, "within 15 seconds") {
		t.Fatalf("block: exit %d, out %q, err %q", code, out, errOut)
	}
	if code, out, _ := run("--list"); code != 0 || !strings.Contains(out, "sb:abc  account report=rep-1") {
		t.Fatalf("list after block: exit %d, out %q", code, out)
	}
	var held bool
	if err := pool.QueryRow(ctx, `SELECT legal_hold FROM room_restrictions WHERE room_id = 'ROOM1'`).Scan(&held); err != nil || !held {
		t.Fatalf("blocking from a report must hold its room: held %v, err %v", held, err)
	}

	// A guest block works by --user and says it does not follow the person.
	if code, out, _ := run("--user", "guest-1", "--block", "--apply"); code != 0 ||
		!strings.Contains(out, "(guest)") || !strings.Contains(out, "fresh guest id") {
		t.Fatalf("guest block: exit %d, out %q", code, out)
	}

	if code, out, _ := run("--user", "sb:abc", "--report", "rep-1", "--unblock", "--apply"); code != 0 ||
		!strings.Contains(out, "after:  blocked=false") {
		t.Fatalf("unblock: exit %d, out %q", code, out)
	}
	if code, out, _ := run("--list"); code != 0 || strings.Contains(out, "sb:abc") || !strings.Contains(out, "guest-1") {
		t.Fatalf("list after unblock: exit %d, out %q", code, out)
	}
	var link string
	if err := pool.QueryRow(ctx, `SELECT report_id FROM person_blocks WHERE user_id = 'sb:abc'`).Scan(&link); err != nil || link != "rep-1" {
		t.Fatalf("unblock must keep the case link: %q, %v", link, err)
	}
	if err := pool.QueryRow(ctx, `SELECT legal_hold FROM room_restrictions WHERE room_id = 'ROOM1'`).Scan(&held); err != nil || !held {
		t.Fatalf("unblocking must leave the hold for the operator to release: held %v, err %v", held, err)
	}
}

// #259: a subscribe from a blocked person ends the connection with the
// terminal blocked code and does not enrol it.
func TestAuthorizeSubscribe_BlockedPerson(t *testing.T) {
	h := hub.NewHub(nil)
	h.RecordClientUserID("c1", "sb:abc")
	h.SetBlockedUsers([]string{"sb:abc"})
	_, err := authorizeSubscribe(h, "c1", "room:ABC123")
	var d centrifuge.Disconnect
	if !errors.As(err, &d) || d.Code != hub.DisconnectUserBlocked.Code {
		t.Fatalf("subscribe by a blocked person: got %v, want the blocked disconnect", err)
	}
	if h.IsMember("c1", "ABC123") {
		t.Fatal("a refused subscribe must not enrol")
	}
}

// #259: the report records who it is about, as resolved at filing time.
func TestReport_RecordsTheSubjectIdentity(t *testing.T) {
	store := report.NewMemory()
	var asked string
	h := reportHandler(store, testRoomSecret, obs.New(), quietLogger(),
		newCallerLimiter(reportBurst, reportRefill), nil,
		func(roomID, kind, subjectID string) hub.Subject {
			asked = roomID + "/" + kind + "/" + subjectID
			return hub.Subject{Sub: "sb:abc", Name: "Ana"}
		})
	if rec := postReport(h, `{"roomId":"R1","kind":"member","subjectId":"c-9","content":"Ana","reason":"x"}`); rec.Code != 204 {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
	got, _ := store.Recent(context.Background(), 1)
	if len(got) != 1 || got[0].SubjectSub != "sb:abc" || got[0].SubjectName != "Ana" || asked != "R1/member/c-9" {
		t.Fatalf("report = %+v, resolver asked %q", got, asked)
	}
}
