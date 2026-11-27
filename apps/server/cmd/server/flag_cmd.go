package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/LucasSantana-Dev/cojam/server/internal/db"
	"github.com/LucasSantana-Dev/cojam/server/internal/flags"
)

const flagUsage = `usage: server flag --list
       server flag --name <flag> (--on | --off | --default) [--rooms A,B | --rooms-default]
                   [--note <text>] (--dry-run | --apply)

Runtime feature flags (docs/specs/feature-flags-panel.md), the same switches
as the /admin/flags panel. Connects with DATABASE_URL; the running server
applies a change within 15 seconds, without a restart.

  --on / --off     override the flag for the server and the web client.
  --default        drop the override: the FEATURE_* variables decide again.
  --rooms          screen share only: the rooms a share may start in
                   (comma-separated; "" = every eligible private room).
  --rooms-default  drop the room override: SCREENSHARE_ROOM_ALLOWLIST decides.
  --list           show every flag, its environment value and override.

Every change is recorded in feature_flag_changes with the note.
`

// runFlag is the `flag` operator subcommand. Exit codes as runRoom: 0 done,
// 1 runtime failure, 2 bad invocation.
func runFlag(args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("flag", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprint(stderr, flagUsage); fs.PrintDefaults() }

	var name, rooms, note string
	var on, off, dflt, roomsDefault, list, dryRun, apply bool
	roomsSet := false
	fs.StringVar(&name, "name", "", "the flag name (see --list)")
	fs.Func("rooms", "screen share room allowlist, comma-separated", func(v string) error {
		rooms, roomsSet = v, true
		return nil
	})
	fs.StringVar(&note, "note", "", "why, recorded with the change")
	fs.BoolVar(&on, "on", false, "turn the flag on")
	fs.BoolVar(&off, "off", false, "turn the flag off")
	fs.BoolVar(&dflt, "default", false, "follow the environment again")
	fs.BoolVar(&roomsDefault, "rooms-default", false, "follow SCREENSHARE_ROOM_ALLOWLIST again")
	fs.BoolVar(&list, "list", false, "list the flags")
	fs.BoolVar(&dryRun, "dry-run", false, "show what would change, change nothing")
	fs.BoolVar(&apply, "apply", false, "make the change")

	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "flag: unexpected argument %q\n", fs.Arg(0))
		return 2
	}
	actions := 0
	for _, b := range []bool{on, off, dflt} {
		if b {
			actions++
		}
	}
	var def flags.Def
	if list {
		if actions > 0 || name != "" || roomsSet || roomsDefault || note != "" || dryRun || apply {
			fmt.Fprintln(stderr, "flag: --list takes no other flag")
			return 2
		}
	} else {
		var ok bool
		if def, ok = flags.Lookup(name); !ok {
			fmt.Fprintf(stderr, "flag: unknown --name %q (see --list)\n", name)
			return 2
		}
		if actions != 1 {
			fmt.Fprintln(stderr, "flag: pass exactly one of --on, --off or --default")
			return 2
		}
		if roomsSet && roomsDefault {
			fmt.Fprintln(stderr, "flag: pass --rooms or --rooms-default, not both")
			return 2
		}
		if dryRun == apply {
			fmt.Fprintln(stderr, "flag: pass exactly one of --dry-run or --apply")
			return 2
		}
	}
	dbURL := getenv("DATABASE_URL")
	if dbURL == "" {
		fmt.Fprintln(stderr, "flag: DATABASE_URL is not set")
		return 2
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.Open(ctx, dbURL)
	if err != nil {
		fmt.Fprintf(stderr, "flag: %v\n", err)
		return 1
	}
	defer pool.Close()
	store := flags.NewPostgres(pool)
	overrides, err := store.List(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "flag: %v\n", err)
		return 1
	}

	if list {
		for _, e := range flags.Resolve(getenv, overrides) {
			printFlag(stdout, e)
		}
		return 0
	}

	cur := overrides[def.Name].Value
	next := cur
	switch {
	case on:
		t := true
		next.Enabled = &t
	case off:
		f := false
		next.Enabled = &f
	case dflt:
		next.Enabled = nil
	}
	if roomsDefault {
		next.Rooms = nil
	}
	u := adminFlagUpdate{Enabled: next.Enabled, Rooms: next.Rooms, Note: note}
	if roomsSet {
		ids := flags.ParseRooms(rooms)
		if ids == nil {
			ids = []string{}
		}
		u.Rooms = &ids
	}
	next, msg := validateFlagUpdate(def, u, getenv)
	if msg != "" {
		fmt.Fprintf(stderr, "flag: %s\n", msg)
		return 2
	}

	fmt.Fprintf(stdout, "before: %s\n", describeValue(cur))
	fmt.Fprintf(stdout, "after:  %s\n", describeValue(next))
	if !apply {
		fmt.Fprintln(stdout, "mode: dry run (nothing changed)")
		return 0
	}
	if _, err := store.Set(ctx, def.Name, next, actorCLI, strings.TrimSpace(note)); err != nil {
		fmt.Fprintf(stderr, "flag: %v (nothing was changed)\n", err)
		return 1
	}
	fmt.Fprintln(stdout, "mode: apply (committed)")
	fmt.Fprintf(stdout, "the running server applies it within %d seconds\n", int(restrictionsPollInterval.Seconds()))
	return 0
}

func describeValue(v flags.Value) string {
	enabled := "default"
	if v.Enabled != nil {
		enabled = map[bool]string{true: "on", false: "off"}[*v.Enabled]
	}
	if v.Rooms == nil {
		return "enabled=" + enabled
	}
	rooms := strings.Join(*v.Rooms, ",")
	if rooms == "" {
		rooms = "all"
	}
	return "enabled=" + enabled + " rooms=" + rooms
}

func printFlag(w io.Writer, e flags.Effective) {
	env := "unset"
	if e.EnvValue != nil {
		env = map[bool]string{true: "on", false: "off"}[*e.EnvValue]
	}
	override := "-"
	if e.Override != nil {
		override = describeValue(e.Override.Value)
	}
	line := fmt.Sprintf("%-12s effective=%-3s source=%-8s %s=%s override=%s",
		e.Name, map[bool]string{true: "on", false: "off"}[e.Enabled], e.Source, e.ServerEnv, env, override)
	if e.AllowlistEnv != "" {
		rooms := strings.Join(e.Rooms, ",")
		if rooms == "" {
			rooms = "all"
		}
		line += " rooms=" + rooms
	}
	if e.Blocked != "" {
		line += " (blocked: needs FEATURE_ROOM_AUTH)"
	}
	fmt.Fprintln(w, line)
}
