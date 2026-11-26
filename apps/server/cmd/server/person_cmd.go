package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/db"
	"github.com/LucasSantana-Dev/cojam/server/internal/restrict"
)

const personUsage = `usage: server person (--report <report id> | --user <id>) (--block | --unblock)
                     (--dry-run | --apply)
       server person --list

Operator block of one person in every room (#259). Connects with DATABASE_URL.

  --report   the report about the person: the server recorded who it names
             when it was filed, with the name (and chat line) it saw. Refused
             when the reporter's copy does not match what the server saw: a
             reporter can point a report at someone else's connection.
             Blocking from a report also puts the report's room under legal
             hold, so the evidence is kept.
  --user     the identity itself ("sb:<uuid>" for an account, a guest id
             otherwise), when there is no report or the report was refused
             and the operator verified the identity another way. With
             --report too, it must match the identity the report names.
  --block    the running server disconnects every connection of the person,
             in every room, within 15 seconds and refuses them at connect.
  --unblock  let the person connect again.
  --list     show every blocked identity.

A block stops one identity, not a person: a blocked account holder can
still use CoJam as a guest, and a guest gets a fresh guest id by clearing
the browser's storage (or on its own after about 31 days away). Procedure: docs/safety/minor-safety-escalation.md.
`

// runPerson is the `person` operator subcommand. Exit codes as runRoom: 0
// done, 1 runtime failure, 2 bad invocation. Output carries the identity and
// ids the operator gave or the report named, flags and times, never report
// content.
func runPerson(args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("person", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprint(stderr, personUsage); fs.PrintDefaults() }

	var userID, reportID string
	var block, unblock, list, dryRun, apply bool
	fs.StringVar(&reportID, "report", "", "the report about the person")
	fs.StringVar(&userID, "user", "", "the identity (sb:<uuid> or a guest id)")
	fs.BoolVar(&block, "block", false, "disconnect the person everywhere and refuse them")
	fs.BoolVar(&unblock, "unblock", false, "let the person connect again")
	fs.BoolVar(&list, "list", false, "list blocked identities")
	fs.BoolVar(&dryRun, "dry-run", false, "show what would change, change nothing")
	fs.BoolVar(&apply, "apply", false, "make the change")

	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "person: unexpected argument %q\n", fs.Arg(0))
		return 2
	}
	userID = strings.TrimSpace(userID)
	reportID = strings.TrimSpace(reportID)
	if list {
		if block || unblock || userID != "" || reportID != "" || dryRun || apply {
			fmt.Fprintln(stderr, "person: --list takes no other flag")
			return 2
		}
	} else {
		if block == unblock {
			fmt.Fprintln(stderr, "person: pass exactly one of --block or --unblock")
			return 2
		}
		if dryRun == apply {
			fmt.Fprintln(stderr, "person: pass exactly one of --dry-run or --apply")
			return 2
		}
		if userID == "" && reportID == "" {
			fmt.Fprintln(stderr, "person: pass --report or --user")
			return 2
		}
		if userID != "" && !restrict.ValidUserID(userID) {
			fmt.Fprintln(stderr, "person: --user must be an identity (sb:<uuid> or a guest id)")
			return 2
		}
		if reportID != "" && !reportSubjectRe.MatchString(reportID) {
			fmt.Fprintln(stderr, "person: --report must be a report id")
			return 2
		}
	}
	dbURL := getenv("DATABASE_URL")
	if dbURL == "" {
		fmt.Fprintln(stderr, "person: DATABASE_URL is not set")
		return 2
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.Open(ctx, dbURL)
	if err != nil {
		fmt.Fprintf(stderr, "person: %v\n", err)
		return 1
	}
	defer pool.Close()
	store := restrict.NewPostgres(pool)

	if list {
		rows, err := store.ListBlocks(ctx)
		if err != nil {
			fmt.Fprintf(stderr, "person: %v\n", err)
			return 1
		}
		if len(rows) == 0 {
			fmt.Fprintln(stdout, "no one is blocked")
			return 0
		}
		for _, b := range rows {
			printBlock(stdout, b)
		}
		return 0
	}

	// The report names the person and the room whose evidence to keep.
	var holdRoom string
	if reportID != "" {
		rep, ok, err := store.GetReportSubject(ctx, reportID)
		if err != nil {
			fmt.Fprintf(stderr, "person: %v\n", err)
			return 1
		}
		if !ok {
			fmt.Fprintln(stderr, "person: no report with that id")
			return 2
		}
		switch {
		case userID == "" && rep.Sub == "":
			fmt.Fprintln(stderr, "person: the report does not name an identity (the person had left, the report is about a room, or it predates this command); pass --user")
			return 2
		case userID == "" && block && !rep.Consistent():
			// The identity is the server's, but the content the operator
			// judged is the reporter's: a mismatch means the report may
			// point at the wrong person.
			fmt.Fprintf(stderr, "person: the reporter's copy does not match what the server saw for that subject (server name %q); verify the identity another way and pass --user\n", rep.Name)
			return 2
		case userID == "":
			userID = rep.Sub
		case rep.Sub != "" && rep.Sub != userID:
			fmt.Fprintln(stderr, "person: --user does not match the identity the report names")
			return 2
		}
		if rep.Name != "" {
			fmt.Fprintf(stdout, "server saw: name %q, reporter's copy matches: %t\n", rep.Name, rep.Consistent())
		}
		holdRoom = rep.RoomID
	}

	cur, _, err := store.GetBlock(ctx, userID)
	if err != nil {
		fmt.Fprintf(stderr, "person: %v\n", err)
		return 1
	}
	next := cur
	next.Blocked = block
	// Only a block re-links the case: an unblock keeps the report that
	// caused the block.
	if block && reportID != "" {
		next.ReportID = reportID
	}

	fmt.Fprintf(stdout, "person: %s (%s)\n", userID, identityKind(userID))
	fmt.Fprintf(stdout, "before: blocked=%t\n", cur.Blocked)
	fmt.Fprintf(stdout, "after:  blocked=%t\n", next.Blocked)
	if block && holdRoom != "" {
		fmt.Fprintf(stdout, "legal hold: room %s\n", holdRoom)
	}
	if block && !restrict.IsAccount(userID) {
		fmt.Fprintln(stdout, "note: a guest identity; the person can come back with a fresh guest id")
	}
	if !apply {
		fmt.Fprintln(stdout, "mode: dry run (nothing changed)")
		return 0
	}

	// Hold first: if the block then fails, the evidence is still kept and a
	// rerun finishes the job. The reverse order could leave a block whose
	// report the retention purge later deletes.
	if block && holdRoom != "" {
		if err := store.HoldRoom(ctx, holdRoom, reportID); err != nil {
			fmt.Fprintf(stderr, "person: %v (nothing was changed)\n", err)
			return 1
		}
	}
	if err := store.PutBlock(ctx, next); err != nil {
		fmt.Fprintf(stderr, "person: %v (the block was not written)\n", err)
		return 1
	}
	fmt.Fprintln(stdout, "mode: apply (committed)")
	if next.Blocked && !cur.Blocked {
		fmt.Fprintf(stdout, "the running server disconnects the person everywhere within %d seconds\n", int(restrictionsPollInterval.Seconds()))
	}
	return 0
}

func identityKind(userID string) string {
	if restrict.IsAccount(userID) {
		return "account"
	}
	return "guest"
}

func printBlock(w io.Writer, b restrict.Block) {
	report := b.ReportID
	if report == "" {
		report = "-"
	}
	fmt.Fprintf(w, "%s  %s report=%s updated=%s\n",
		b.UserID, identityKind(b.UserID), report, b.UpdatedAt.UTC().Format(time.RFC3339))
}
