package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/dbtest"
)

// #259: the command refuses anything ambiguous before touching a database.
func TestRunRoom_RejectsBadInvocations(t *testing.T) {
	env := envOf(map[string]string{"DATABASE_URL": "postgres://unused/db"})
	for name, args := range map[string][]string{
		"no action":        {"--room", "ROOM1", "--dry-run"},
		"two actions":      {"--room", "ROOM1", "--close", "--hold", "--apply"},
		"no mode":          {"--room", "ROOM1", "--close"},
		"both modes":       {"--room", "ROOM1", "--close", "--dry-run", "--apply"},
		"no room":          {"--close", "--apply"},
		"bad room id":      {"--room", "room one", "--close", "--apply"},
		"list with action": {"--list", "--close"},
		"list with room":   {"--list", "--room", "ROOM1"},
		"stray positional": {"--room", "ROOM1", "--close", "--apply", "extra"},
		"unknown flag":     {"--room", "ROOM1", "--close", "--apply", "--force"},
	} {
		var out, errOut bytes.Buffer
		if code := runRoom(args, env, &out, &errOut); code != 2 {
			t.Errorf("%s: exit = %d, want 2 (stderr %q)", name, code, errOut.String())
		}
	}
	var out, errOut bytes.Buffer
	if code := runRoom([]string{"--list"}, envOf(nil), &out, &errOut); code != 2 ||
		!strings.Contains(errOut.String(), "DATABASE_URL") {
		t.Fatalf("missing DATABASE_URL: exit %d, stderr %q", code, errOut.String())
	}
}

// #259: the operator path end to end against the database: a dry run changes
// nothing, close sets the hold too, release is refused while closed, reopen
// keeps the hold. Skips if TEST_DATABASE_URL is not set.
func TestRunRoom_CloseReopenRelease(t *testing.T) {
	pool := dbtest.Isolated(t)
	env := envOf(map[string]string{"DATABASE_URL": pool.Config().ConnString()})
	run := func(args ...string) (int, string, string) {
		var out, errOut bytes.Buffer
		code := runRoom(args, env, &out, &errOut)
		return code, out.String(), errOut.String()
	}

	if code, out, _ := run("--room", "ROOM1", "--close", "--report", "rep-9", "--dry-run"); code != 0 ||
		!strings.Contains(out, "after:  closed=true legal_hold=true") || !strings.Contains(out, "dry run") {
		t.Fatalf("dry run: exit %d, out %q", code, out)
	}
	if code, out, _ := run("--list"); code != 0 || !strings.Contains(out, "no room") {
		t.Fatalf("a dry run must change nothing: exit %d, out %q", code, out)
	}

	if code, out, errOut := run("--room", "ROOM1", "--close", "--report", "rep-9", "--apply"); code != 0 ||
		!strings.Contains(out, "committed") || !strings.Contains(out, "within 15 seconds") {
		t.Fatalf("close: exit %d, out %q, err %q", code, out, errOut)
	}
	if code, out, _ := run("--list"); code != 0 ||
		!strings.Contains(out, "ROOM1  closed=true legal_hold=true report=rep-9") {
		t.Fatalf("list after close: exit %d, out %q", code, out)
	}

	if code, _, errOut := run("--room", "ROOM1", "--release", "--apply"); code != 2 ||
		!strings.Contains(errOut, "reopen") {
		t.Fatalf("release while closed: exit %d, err %q; want refusal", code, errOut)
	}

	if code, out, _ := run("--room", "ROOM1", "--reopen", "--apply"); code != 0 ||
		!strings.Contains(out, "after:  closed=false legal_hold=true") {
		t.Fatalf("reopen: exit %d, out %q", code, out)
	}
	if code, out, _ := run("--room", "ROOM1", "--release", "--apply"); code != 0 ||
		!strings.Contains(out, "after:  closed=false legal_hold=false") {
		t.Fatalf("release: exit %d, out %q", code, out)
	}
	if code, out, _ := run("--list"); code != 0 || !strings.Contains(out, "no room") {
		t.Fatalf("list after release: exit %d, out %q", code, out)
	}
}
