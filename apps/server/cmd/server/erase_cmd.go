package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/db"
	"github.com/LucasSantana-Dev/cojam/server/internal/erase"
)

// stringList is a repeatable string flag.
type stringList []string

func (s *stringList) String() string     { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error { *s = append(*s, v); return nil }

const eraseUsage = `usage: server erase --sub <sub> [--name <display name>] [--client-id <id>]...
                    [--include-subject-reports] (--dry-run | --apply)

Erases or anonymizes one person's data for an LGPD deletion request (#318).
Connects with DATABASE_URL. Stop the server first: a room held in memory
would write the person back on its next change.
Procedure: docs/runbooks/lgpd-erasure.md.
`

// runErase is the `erase` operator subcommand. It returns the process exit
// code: 0 done, 1 runtime failure, 2 bad invocation. Output is counts per
// table only, never identifiers or content, so it is safe to paste into a
// ticket.
func runErase(args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("erase", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprint(stderr, eraseUsage); fs.PrintDefaults() }

	var req erase.Request
	var clientIDs stringList
	var dryRun, apply bool
	fs.StringVar(&req.Sub, "sub", "", "the person's id (guest id shown in the app, or sb:<uuid>)")
	fs.StringVar(&req.Name, "name", "", "display name the person used (optional)")
	fs.Var(&clientIDs, "client-id", "connection id seen in reports or moderation rows (optional, repeatable)")
	fs.BoolVar(&req.IncludeSubjectReports, "include-subject-reports", false,
		"also delete reports ABOUT the person (kept by default as evidence)")
	fs.BoolVar(&dryRun, "dry-run", false, "count what would change, change nothing")
	fs.BoolVar(&apply, "apply", false, "make the changes, in one transaction")

	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "erase: unexpected argument %q\n", fs.Arg(0))
		return 2
	}
	if dryRun == apply {
		fmt.Fprintln(stderr, "erase: pass exactly one of --dry-run or --apply")
		return 2
	}
	req.Sub = strings.TrimSpace(req.Sub)
	req.Name = strings.TrimSpace(req.Name)
	req.ClientIDs = clientIDs
	if err := req.Validate(); err != nil {
		fmt.Fprintf(stderr, "erase: %v\n", err)
		return 2
	}
	dbURL := getenv("DATABASE_URL")
	if dbURL == "" {
		fmt.Fprintln(stderr, "erase: DATABASE_URL is not set")
		return 2
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool, err := db.Open(ctx, dbURL)
	if err != nil {
		fmt.Fprintf(stderr, "erase: %v\n", err)
		return 1
	}
	defer pool.Close()

	c, err := erase.Run(ctx, pool, req, apply)
	if err != nil {
		// Errors come from the database driver; they do not echo parameters.
		if errors.Is(err, erase.ErrCommitUnknown) {
			fmt.Fprintf(stderr, "erase: %v; run --dry-run to see what remains (re-running is safe)\n", err)
		} else {
			fmt.Fprintf(stderr, "erase: %v (nothing was changed)\n", err)
		}
		return 1
	}
	printEraseCounts(stdout, c, apply)
	return 0
}

func printEraseCounts(w io.Writer, c erase.Counts, applied bool) {
	if applied {
		fmt.Fprintln(w, "mode: apply (committed)")
	} else {
		fmt.Fprintln(w, "mode: dry run (nothing changed)")
	}
	fmt.Fprintf(w, "spotify_tokens      deleted: %d\n", c.SpotifyTokensDeleted)
	fmt.Fprintf(w, "rooms               rewritten: %d (queue entries anonymized: %d, votes removed: %d, hosts cleared: %d)\n",
		c.RoomsRewritten, c.QueueEntriesAnonymized, c.VotesRemoved, c.HostsCleared)
	fmt.Fprintf(w, "reports             reporter anonymized: %d, about the person deleted: %d, about the person retained: %d\n",
		c.ReportsReporterAnonymized, c.ReportsSubjectDeleted, c.ReportsSubjectRetained)
	fmt.Fprintf(w, "moderation_actions  actor anonymized: %d, subject anonymized: %d, retained with kept reports: %d\n",
		c.ModerationActorAnonymized, c.ModerationSubjectAnonymized, c.ModerationSubjectRetained)
	fmt.Fprintf(w, "rebound_subs        retained: %d\n", c.ReboundSubsRetained)
}
