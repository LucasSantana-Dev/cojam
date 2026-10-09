package main

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/LucasSantana-Dev/cojam/server/internal/dbtest"
)

func envOf(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

// #318: the command refuses anything ambiguous before touching a database.
func TestRunErase_RejectsBadInvocations(t *testing.T) {
	env := envOf(map[string]string{"DATABASE_URL": "postgres://unused/db"})
	for name, args := range map[string][]string{
		"no mode":          {"--sub", "abc"},
		"both modes":       {"--sub", "abc", "--dry-run", "--apply"},
		"no sub":           {"--dry-run"},
		"blank sub":        {"--sub", "  ", "--dry-run"},
		"empty client id":  {"--sub", "abc", "--client-id", "", "--dry-run"},
		"stray positional": {"--sub", "abc", "--dry-run", "extra"},
		"unknown flag":     {"--sub", "abc", "--dry-run", "--force"},
	} {
		var out, errOut bytes.Buffer
		if code := runErase(args, env, &out, &errOut); code != 2 {
			t.Errorf("%s: exit = %d, want 2 (stderr %q)", name, code, errOut.String())
		}
	}

	var out, errOut bytes.Buffer
	if code := runErase([]string{"--sub", "abc", "--dry-run"}, envOf(nil), &out, &errOut); code != 2 ||
		!strings.Contains(errOut.String(), "DATABASE_URL") {
		t.Fatalf("missing DATABASE_URL: exit %d, stderr %q", code, errOut.String())
	}

	// Without the server's key the person's product_events rows cannot be
	// found: refuse rather than report a clean erasure that missed them.
	out.Reset()
	errOut.Reset()
	if code := runErase([]string{"--sub", "abc", "--dry-run"}, env, &out, &errOut); code != 2 ||
		!strings.Contains(errOut.String(), "EVENTS_HMAC_KEY") {
		t.Fatalf("missing EVENTS_HMAC_KEY: exit %d, stderr %q", code, errOut.String())
	}
}

// #318: a dry run prints counts per table and never the identifiers or any
// content. Skips if TEST_DATABASE_URL is not set.
func TestRunErase_DryRunPrintsCountsOnly(t *testing.T) {
	ctx := context.Background()
	pool := dbtest.Isolated(t)
	// runErase opens its own pool, so hand it the same isolated schema.
	isolatedURL := pool.Config().ConnString()

	const sub = "eraseCmdSubject77"
	if _, err := pool.Exec(ctx, `INSERT INTO reports (id, room_id, kind, reporter_sub, content, reason)
		VALUES ('erase-cmd-r1', 'erase-cmd-room', 'room', $1, 'conteudo privado', 'motivo')`, sub); err != nil {
		t.Fatalf("seed: %v", err)
	}

	var out, errOut bytes.Buffer
	code := runErase([]string{"--sub", sub, "--name", "Fulana", "--dry-run"},
		envOf(map[string]string{"DATABASE_URL": isolatedURL, "EVENTS_HMAC_KEY": "erase-cmd-key"}), &out, &errOut)
	if code != 0 {
		t.Fatalf("exit = %d, stderr %q", code, errOut.String())
	}
	got := out.String()
	for _, want := range []string{"dry run", "spotify_tokens", "rooms", "reports", "moderation_actions", "rebound_subs",
		"product_events      deleted: 0", "reporter anonymized: 1"} {
		if !strings.Contains(got, want) {
			t.Fatalf("output missing %q:\n%s", want, got)
		}
	}
	for _, leak := range []string{sub, "Fulana", "conteudo privado", "motivo"} {
		if strings.Contains(got+errOut.String(), leak) {
			t.Fatalf("output leaks %q:\n%s", leak, got)
		}
	}
	var reporter string
	pool.QueryRow(ctx, "SELECT reporter_sub FROM reports WHERE id = 'erase-cmd-r1'").Scan(&reporter)
	if reporter != sub {
		t.Fatal("dry run must not change the database")
	}
}
