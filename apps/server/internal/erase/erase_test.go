package erase

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/LucasSantana-Dev/cojam/server/internal/db"
	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

const (
	person = "subPerson01"
	other  = "subOther02"
)

func TestRequestValidate(t *testing.T) {
	if err := (Request{}).Validate(); err == nil {
		t.Fatal("empty sub must be rejected")
	}
	if err := (Request{Sub: "   "}).Validate(); err == nil {
		t.Fatal("blank sub must be rejected")
	}
	if err := (Request{Sub: person, ClientIDs: []string{""}}).Validate(); err == nil {
		t.Fatal("empty client id must be rejected: it would match every unattributed row")
	}
	if err := (Request{Sub: person, Name: "Ana", ClientIDs: []string{"c1"}}).Validate(); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
}

func roomFixture() *queue.RoomState {
	return &queue.RoomState{
		RoomID:     "room-a",
		HostUserID: person,
		Version:    7,
		Queue: []queue.TrackRef{
			{ID: "t1", Title: "One", AddedBy: "Ana", AddedByUserID: person},
			{ID: "t2", Title: "Two", AddedBy: "Bia", AddedByUserID: other},
			{ID: "t3", Title: "Three", AddedBy: "Ana"}, // name-only attribution (no identity)
			{ID: "t4", Title: "Four", AddedBy: "Bia"},
		},
		Votes: map[string][]string{
			"t1": {"user:" + person, "user:" + other},
			"t2": {"user:" + person},
			"t4": {"client:c-person", "user:" + other},
		},
	}
}

// #318: every trace of the sub inside room state goes; other people's
// attribution and votes stay untouched; one version bump for the rewrite.
func TestScrubRoom_RemovesThePersonOnly(t *testing.T) {
	s := roomFixture()
	ch := ScrubRoom(s, Request{Sub: person, Name: "Ana", ClientIDs: []string{"c-person"}})

	if s.HostUserID != "" || !ch.HostCleared {
		t.Fatalf("host must be cleared, got %q (changes %+v)", s.HostUserID, ch)
	}
	if s.Queue[0].AddedByUserID != "" || s.Queue[0].AddedBy != RemovedName {
		t.Fatalf("person's entry not anonymized: %+v", s.Queue[0])
	}
	if s.Queue[2].AddedBy != RemovedName {
		t.Fatalf("name-only entry in a room the person is in must be anonymized: %+v", s.Queue[2])
	}
	if s.Queue[1].AddedBy != "Bia" || s.Queue[1].AddedByUserID != other || s.Queue[3].AddedBy != "Bia" {
		t.Fatalf("other people's attribution must survive: %+v", s.Queue)
	}
	if ch.QueueEntries != 2 {
		t.Fatalf("queue entries = %d, want 2", ch.QueueEntries)
	}
	want := map[string][]string{"t1": {"user:" + other}, "t4": {"user:" + other}}
	if !reflect.DeepEqual(s.Votes, want) {
		t.Fatalf("votes = %v, want %v (empty track entries dropped)", s.Votes, want)
	}
	if ch.Votes != 3 {
		t.Fatalf("votes removed = %d, want 3", ch.Votes)
	}
	if s.Version != 8 {
		t.Fatalf("version = %d, want exactly one bump to 8", s.Version)
	}
}

// #318: a display name alone is not an identity. Name-only entries are only
// touched in rooms where the person's sub or client id is present, so a
// stranger with the same name in an unrelated room keeps their attribution.
func TestScrubRoom_NameOnlyNeedsThePersonInTheRoom(t *testing.T) {
	s := &queue.RoomState{
		RoomID:  "room-b",
		Version: 3,
		Queue:   []queue.TrackRef{{ID: "t1", AddedBy: "Ana"}},
	}
	ch := ScrubRoom(s, Request{Sub: person, Name: "Ana"})
	if ch.Changed() || s.Queue[0].AddedBy != "Ana" || s.Version != 3 {
		t.Fatalf("room without the person must be untouched: %+v %+v", ch, s)
	}
}

// #318: running the scrub again changes nothing.
func TestScrubRoom_Idempotent(t *testing.T) {
	s := roomFixture()
	req := Request{Sub: person, Name: "Ana", ClientIDs: []string{"c-person"}}
	ScrubRoom(s, req)
	before, _ := json.Marshal(s)
	ch := ScrubRoom(s, req)
	after, _ := json.Marshal(s)
	if ch.Changed() || string(before) != string(after) {
		t.Fatalf("second scrub changed state: %+v", ch)
	}
}

// isolatedPool opens TEST_DATABASE_URL in a private schema, migrated from
// scratch and dropped afterwards. Other test packages truncate and age rows in
// the shared public schema concurrently; a private schema keeps both sides
// from seeing each other. Skips if TEST_DATABASE_URL is not set.
func isolatedPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	schema := fmt.Sprintf("erase_test_%d_%d", os.Getpid(), time.Now().UnixNano())

	admin, err := db.Open(ctx, dbURL)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
	})

	u, err := url.Parse(dbURL)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	pool, err := db.Open(ctx, u.String())
	if err != nil {
		t.Fatalf("open isolated: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return pool
}

func mustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("exec %q: %v", sql, err)
	}
}

// seed writes one row per place a person's identifiers live, plus rows that
// belong to someone else and must survive.
func seed(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	state, _ := json.Marshal(roomFixture())
	mustExec(t, pool, `INSERT INTO rooms (room_id, state, version, updated_at)
		VALUES ('room-a', $1, 7, '2026-01-01T00:00:00Z')`, state)
	otherRoom, _ := json.Marshal(&queue.RoomState{RoomID: "room-z", Version: 1,
		Queue: []queue.TrackRef{{ID: "z1", AddedBy: "Ana"}}})
	mustExec(t, pool, `INSERT INTO rooms (room_id, state, version) VALUES ('room-z', $1, 1)`, otherRoom)

	mustExec(t, pool, `INSERT INTO spotify_tokens (sub, sealed_token, expires_at) VALUES
		($1, 'sealed', now() + interval '1 day'), ($2, 'sealed', now() + interval '1 day')`, person, other)
	mustExec(t, pool, `INSERT INTO rebound_subs (sub) VALUES ($1)`, person)

	// r1: filed BY the person about someone else.
	// r2: a member report ABOUT the person (by client id), filed by other.
	// r3: a message report ABOUT the person (by display name in the reason).
	// r4: unrelated.
	mustExec(t, pool, `INSERT INTO reports (id, room_id, kind, reporter_sub, subject_id, content, reason) VALUES
		('r1', 'room-a', 'member', $1, 'c-other', 'Bia', 'spam'),
		('r2', 'room-a', 'member', $2, 'c-person', 'Ana', 'assédio'),
		('r3', 'room-a', 'message', $2, 'msg-9', 'texto ofensivo', '[harassment] reported message from Ana'),
		('r4', 'room-z', 'room', $2, '', '', 'nome da sala'),
		('r5', 'room-z', 'member', $2, 'c-stranger', 'Ana', 'outra pessoa'),
		('r6', 'room-z', 'message', $2, 'msg-z', 'oi', 'reported message from Ana')`, person, other)
	// r5 and r6 are about a stranger who is also called Ana, in a room the
	// person was never identified in. A name alone must not reach them.

	// m1: the person (as host) kicked someone, unlinked: actor anonymized.
	// m2: the person was kicked, linked to retained report r2: kept.
	// m3: chat.delete of the reported message, actor other: untouched.
	mustExec(t, pool, `INSERT INTO moderation_actions (id, room_id, action, actor_user_id, subject_id) VALUES
		('m1', 'room-a', 'room.kick', $1, 'c-other'),
		('m2', 'room-a', 'room.kick', $2, 'c-person'),
		('m3', 'room-a', 'chat.delete', $2, 'msg-9')`, person, other)
}

func baseRequest() Request {
	return Request{Sub: person, Name: "Ana", ClientIDs: []string{"c-person"}}
}

func snapshot(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var b strings.Builder
	for _, q := range []string{
		"SELECT room_id || ':' || version || ':' || state::text || ':' || updated_at::text FROM rooms ORDER BY room_id",
		"SELECT sub FROM spotify_tokens ORDER BY sub",
		"SELECT id || ':' || reporter_sub || ':' || subject_id || ':' || content || ':' || reason FROM reports ORDER BY id",
		"SELECT id || ':' || actor_user_id || ':' || subject_id FROM moderation_actions ORDER BY id",
		"SELECT sub FROM rebound_subs ORDER BY sub",
	} {
		rows, err := pool.Query(context.Background(), q)
		if err != nil {
			t.Fatalf("snapshot %q: %v", q, err)
		}
		for rows.Next() {
			var s string
			if err := rows.Scan(&s); err != nil {
				t.Fatalf("scan: %v", err)
			}
			b.WriteString(s + "\n")
		}
		rows.Close()
	}
	return b.String()
}

// #318: dry-run reports exactly what apply would do and changes nothing.
func TestRun_DryRunChangesNothingAndMatchesApply(t *testing.T) {
	pool := isolatedPool(t)
	seed(t, pool)
	before := snapshot(t, pool)

	dry, err := Run(context.Background(), pool, baseRequest(), false)
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if after := snapshot(t, pool); after != before {
		t.Fatalf("dry run changed the database:\nbefore:\n%s\nafter:\n%s", before, after)
	}

	applied, err := Run(context.Background(), pool, baseRequest(), true)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if dry != applied {
		t.Fatalf("dry-run counts %+v differ from apply counts %+v", dry, applied)
	}
}

// #318: per-table behaviour of apply, against every row seeded.
func TestRun_ApplyPerTable(t *testing.T) {
	pool := isolatedPool(t)
	seed(t, pool)
	ctx := context.Background()

	got, err := Run(ctx, pool, baseRequest(), true)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	want := Counts{
		SpotifyTokensDeleted:      1,
		RoomsRewritten:            1,
		QueueEntriesAnonymized:    2,
		VotesRemoved:              3,
		HostsCleared:              1,
		ReportsReporterAnonymized: 1,
		ReportsSubjectRetained:    2,
		ModerationActorAnonymized: 1,
		ModerationSubjectRetained: 1,
		ReboundSubsRetained:       1,
	}
	if got != want {
		t.Fatalf("counts = %+v\nwant     %+v", got, want)
	}

	// spotify_tokens: the person's row is gone, the other survives.
	var n int
	pool.QueryRow(ctx, "SELECT count(*) FROM spotify_tokens WHERE sub = $1", person).Scan(&n)
	if n != 0 {
		t.Fatal("person's Spotify token row must be deleted")
	}
	pool.QueryRow(ctx, "SELECT count(*) FROM spotify_tokens WHERE sub = $1", other).Scan(&n)
	if n != 1 {
		t.Fatal("other people's Spotify token rows must survive")
	}

	// rooms: no trace of the sub or client id; updated_at not refreshed (an
	// erasure must not extend the room's idle retention); version bumped.
	var state string
	var version int64
	var updated time.Time
	pool.QueryRow(ctx, "SELECT state::text, version, updated_at FROM rooms WHERE room_id = 'room-a'").
		Scan(&state, &version, &updated)
	if strings.Contains(state, person) || strings.Contains(state, "c-person") {
		t.Fatalf("room state still holds the person: %s", state)
	}
	if version != 8 {
		t.Fatalf("version = %d, want 8", version)
	}
	if !updated.Equal(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("updated_at moved to %v; erasure must not reset the idle clock", updated)
	}
	var loaded queue.RoomState
	if err := json.Unmarshal([]byte(state), &loaded); err != nil || loaded.Version != version {
		t.Fatalf("state version %d must match column %d (%v)", loaded.Version, version, err)
	}
	pool.QueryRow(ctx, "SELECT state::text FROM rooms WHERE room_id = 'room-z'").Scan(&state)
	var stranger queue.RoomState
	if err := json.Unmarshal([]byte(state), &stranger); err != nil || stranger.Queue[0].AddedBy != "Ana" {
		t.Fatalf("a same-named stranger in another room must keep attribution: %s", state)
	}

	// reports: reporter identity gone; subject rows kept as evidence.
	var reporter string
	pool.QueryRow(ctx, "SELECT reporter_sub FROM reports WHERE id = 'r1'").Scan(&reporter)
	if reporter != "" {
		t.Fatalf("reporter_sub = %q, want anonymized", reporter)
	}
	pool.QueryRow(ctx, "SELECT count(*) FROM reports WHERE id IN ('r2', 'r3', 'r4')").Scan(&n)
	if n != 3 {
		t.Fatalf("subject and unrelated reports must be retained, have %d of 3", n)
	}

	// moderation_actions: actor anonymized where unlinked, linked row kept.
	var actor, subject string
	pool.QueryRow(ctx, "SELECT actor_user_id FROM moderation_actions WHERE id = 'm1'").Scan(&actor)
	if actor != "" {
		t.Fatalf("m1 actor = %q, want anonymized", actor)
	}
	pool.QueryRow(ctx, "SELECT subject_id FROM moderation_actions WHERE id = 'm2'").Scan(&subject)
	if subject != "c-person" {
		t.Fatalf("m2 subject = %q, must be kept while its report is retained", subject)
	}
}

// #318: --include-subject-reports deletes the reports about the person, and
// with them the reason to keep linked moderation rows.
func TestRun_IncludeSubjectReports(t *testing.T) {
	pool := isolatedPool(t)
	seed(t, pool)
	ctx := context.Background()
	req := baseRequest()
	req.IncludeSubjectReports = true

	got, err := Run(ctx, pool, req, true)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if got.ReportsSubjectDeleted != 2 || got.ReportsSubjectRetained != 0 {
		t.Fatalf("subject reports deleted/retained = %d/%d, want 2/0", got.ReportsSubjectDeleted, got.ReportsSubjectRetained)
	}
	if got.ModerationSubjectAnonymized != 1 || got.ModerationSubjectRetained != 0 {
		t.Fatalf("moderation subject anonymized/retained = %d/%d, want 1/0",
			got.ModerationSubjectAnonymized, got.ModerationSubjectRetained)
	}
	var n int
	pool.QueryRow(ctx, "SELECT count(*) FROM reports WHERE id IN ('r2', 'r3')").Scan(&n)
	if n != 0 {
		t.Fatal("subject reports must be deleted")
	}
	pool.QueryRow(ctx, "SELECT count(*) FROM reports WHERE id IN ('r1', 'r4', 'r5', 'r6')").Scan(&n)
	if n != 4 {
		t.Fatalf("reports not about the person must survive, including a same-named stranger's (%d of 4)", n)
	}
}

// #318: a second apply finds nothing left to change; only the retained
// counts repeat.
func TestRun_Idempotent(t *testing.T) {
	pool := isolatedPool(t)
	seed(t, pool)
	ctx := context.Background()

	if _, err := Run(ctx, pool, baseRequest(), true); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	before := snapshot(t, pool)
	got, err := Run(ctx, pool, baseRequest(), true)
	if err != nil {
		t.Fatalf("second apply: %v", err)
	}
	want := Counts{ReportsSubjectRetained: 2, ModerationSubjectRetained: 1, ReboundSubsRetained: 1}
	if got != want {
		t.Fatalf("second apply counts = %+v, want only retained %+v", got, want)
	}
	if after := snapshot(t, pool); after != before {
		t.Fatalf("second apply changed the database:\nbefore:\n%s\nafter:\n%s", before, after)
	}
}

// #318: without a name or client id, only the sub is matched: reports about
// the person cannot be found (they are keyed by client id and name), and
// nothing else is touched.
func TestRun_SubOnly(t *testing.T) {
	pool := isolatedPool(t)
	seed(t, pool)

	got, err := Run(context.Background(), pool, Request{Sub: person}, true)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if got.ReportsSubjectRetained != 0 || got.ModerationSubjectRetained != 0 {
		t.Fatalf("subject matching needs --name or --client-id, got %+v", got)
	}
	if got.QueueEntriesAnonymized != 1 || got.VotesRemoved != 2 {
		t.Fatalf("sub-only: queue %d votes %d, want 1 and 2", got.QueueEntriesAnonymized, got.VotesRemoved)
	}
	// m1 (actor) is unlinked and m2 is no longer protected by a matched
	// subject report, but m2 matches the person only by client id, which was
	// not given: it stays.
	if got.ModerationActorAnonymized != 1 {
		t.Fatalf("actor anonymized = %d, want 1", got.ModerationActorAnonymized)
	}
}
