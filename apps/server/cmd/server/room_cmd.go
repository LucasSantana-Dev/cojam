package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/db"
	"github.com/LucasSantana-Dev/cojam/server/internal/hub"
	"github.com/LucasSantana-Dev/cojam/server/internal/restrict"
)

const roomUsage = `usage: server room --room <id> (--close | --reopen | --hold | --release)
                   [--report <report id>] (--dry-run | --apply)
       server room --list

Operator restrictions on one room (#259). Connects with DATABASE_URL.

  --close    end the room: the running server disconnects everyone in it
             within 15 seconds and refuses every rejoin. Also sets the
             legal hold, since a closure follows a report.
  --reopen   accept joins again. The legal hold stays until --release.
  --hold     keep the room's reports and moderation actions past
             REPORT_RETENTION_DAYS and through 'server erase'.
  --release  lift the hold (refused while the room is closed).
  --list     show every room that is closed or held.

Procedure: docs/safety/minor-safety-escalation.md.
`

// runRoom is the `room` operator subcommand. Exit codes as runErase: 0 done,
// 1 runtime failure, 2 bad invocation. Output carries the room id the
// operator typed, flags and times, never report content.
func runRoom(args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("room", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprint(stderr, roomUsage); fs.PrintDefaults() }

	var roomID, reportID string
	var closeRoom, reopen, hold, release, list, dryRun, apply bool
	fs.StringVar(&roomID, "room", "", "the room id (from the report or the room link)")
	fs.StringVar(&reportID, "report", "", "the report id this action answers (optional)")
	fs.BoolVar(&closeRoom, "close", false, "end the room and refuse rejoins (sets the hold)")
	fs.BoolVar(&reopen, "reopen", false, "accept joins again (the hold stays)")
	fs.BoolVar(&hold, "hold", false, "keep the room's reports past retention and erasure")
	fs.BoolVar(&release, "release", false, "lift the legal hold")
	fs.BoolVar(&list, "list", false, "list rooms that are closed or held")
	fs.BoolVar(&dryRun, "dry-run", false, "show what would change, change nothing")
	fs.BoolVar(&apply, "apply", false, "make the change")

	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "room: unexpected argument %q\n", fs.Arg(0))
		return 2
	}
	actions := 0
	for _, on := range []bool{closeRoom, reopen, hold, release} {
		if on {
			actions++
		}
	}
	roomID = strings.TrimSpace(roomID)
	reportID = strings.TrimSpace(reportID)
	if list {
		if actions > 0 || roomID != "" || reportID != "" || dryRun || apply {
			fmt.Fprintln(stderr, "room: --list takes no other flag")
			return 2
		}
	} else {
		if actions != 1 {
			fmt.Fprintln(stderr, "room: pass exactly one of --close, --reopen, --hold or --release")
			return 2
		}
		if dryRun == apply {
			fmt.Fprintln(stderr, "room: pass exactly one of --dry-run or --apply")
			return 2
		}
		if !hub.ValidRoomID(roomID) {
			fmt.Fprintln(stderr, "room: --room must be a valid room id")
			return 2
		}
	}
	dbURL := getenv("DATABASE_URL")
	if dbURL == "" {
		fmt.Fprintln(stderr, "room: DATABASE_URL is not set")
		return 2
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.Open(ctx, dbURL)
	if err != nil {
		fmt.Fprintf(stderr, "room: %v\n", err)
		return 1
	}
	defer pool.Close()
	store := restrict.NewPostgres(pool)

	if list {
		rows, err := store.List(ctx)
		if err != nil {
			fmt.Fprintf(stderr, "room: %v\n", err)
			return 1
		}
		if len(rows) == 0 {
			fmt.Fprintln(stdout, "no room is closed or held")
			return 0
		}
		for _, r := range rows {
			printRestriction(stdout, r)
		}
		return 0
	}

	cur, _, err := store.Get(ctx, roomID)
	if err != nil {
		fmt.Fprintf(stderr, "room: %v\n", err)
		return 1
	}
	next := cur
	switch {
	case closeRoom:
		next.Closed, next.LegalHold = true, true
	case reopen:
		next.Closed = false
	case hold:
		next.LegalHold = true
	case release:
		if cur.Closed {
			fmt.Fprintln(stderr, "room: the room is closed; --reopen it before releasing the hold")
			return 2
		}
		next.LegalHold = false
	}
	if reportID != "" {
		next.ReportID = reportID
	}

	fmt.Fprintf(stdout, "before: closed=%t legal_hold=%t\n", cur.Closed, cur.LegalHold)
	fmt.Fprintf(stdout, "after:  closed=%t legal_hold=%t\n", next.Closed, next.LegalHold)
	if !apply {
		fmt.Fprintln(stdout, "mode: dry run (nothing changed)")
		return 0
	}
	if err := store.Put(ctx, next); err != nil {
		fmt.Fprintf(stderr, "room: %v (nothing was changed)\n", err)
		return 1
	}
	fmt.Fprintln(stdout, "mode: apply (committed)")
	if next.Closed && !cur.Closed {
		fmt.Fprintf(stdout, "the running server ends the room within %d seconds\n", int(restrictionsPollInterval.Seconds()))
	}
	return 0
}

func printRestriction(w io.Writer, r restrict.Restriction) {
	report := r.ReportID
	if report == "" {
		report = "-"
	}
	fmt.Fprintf(w, "%s  closed=%t legal_hold=%t report=%s updated=%s\n",
		r.RoomID, r.Closed, r.LegalHold, report, r.UpdatedAt.UTC().Format(time.RFC3339))
}
