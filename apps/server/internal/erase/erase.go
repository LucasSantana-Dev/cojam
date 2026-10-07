// Package erase removes or anonymizes one person's data across the database,
// for an LGPD art. 18 deletion request (#318). It backs the operator command
// `server erase`; the procedure is in docs/runbooks/lgpd-erasure.md.
//
// Where a person's identifiers live (grep-verified, #318):
//
//   - spotify_tokens.sub: sealed Spotify refresh token, keyed by sub. Deleted.
//   - rooms.state (jsonb): queue[].addedByUserId (sub) and queue[].addedBy
//     (display name), votes ("user:<sub>", "client:<clientId>"), hostUserId
//     (sub). Rewritten in place.
//   - reports.reporter_sub (sub of whoever filed it): anonymized.
//   - reports.subject_id (client id for member reports, message id for
//     message reports) plus the person's display name in content (member
//     reports) or reason (message reports): kept by default, see below.
//   - moderation_actions.actor_user_id (host sub): anonymized. subject_id
//     (client id or message id): anonymized unless tied to a kept report.
//   - rebound_subs.sub: kept. It is the burn list that stops a consumed guest
//     token from minting connections again; deleting it would revive the
//     identity, and it links to nothing once the rest is erased.
//
// Reports where the person is the subject are evidence kept under a legal
// obligation (LGPD art. 7 II and art. 16 I) and are retained unless the
// operator passes IncludeSubjectReports. That default is pending legal review.
// A display name only matches reports and queue entries inside rooms where
// the person's sub or client id was found: names are free and not unique.
//
// Not covered here: in-memory server state (chat, presence, resident rooms;
// the runbook stops the server first), container logs, and Supabase accounts
// (disabled; the project no longer exists).
package erase

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/LucasSantana-Dev/cojam/server/internal/queue"
)

// RemovedName replaces the display name on anonymized queue entries.
const RemovedName = "Removido"

// Request names the person to erase.
type Request struct {
	// Sub is the person's identity: the guest id the browser keeps as
	// cojam_uid, or "sb:<uuid>" for an account. Required.
	Sub string
	// Name is the display name the person used, optional. It finds reports
	// about them and name-only queue attribution in rooms they were in.
	Name string
	// ClientIDs are per-connection ids, optional. The person cannot know
	// them; the operator finds them in reports or moderation rows.
	ClientIDs []string
	// IncludeSubjectReports deletes reports about the person instead of
	// keeping them as evidence.
	IncludeSubjectReports bool
}

// Validate rejects requests that would match too much.
func (r Request) Validate() error {
	if strings.TrimSpace(r.Sub) == "" {
		return errors.New("sub is required")
	}
	for _, c := range r.ClientIDs {
		if strings.TrimSpace(c) == "" {
			return errors.New("client id must not be empty")
		}
	}
	return nil
}

// Counts is what one run did (or, in a dry run, would do), per table. It
// never carries content.
type Counts struct {
	SpotifyTokensDeleted int64

	RoomsRewritten         int64
	QueueEntriesAnonymized int64
	VotesRemoved           int64
	HostsCleared           int64

	ReportsReporterAnonymized int64
	ReportsSubjectDeleted     int64
	ReportsSubjectRetained    int64

	ModerationActorAnonymized   int64
	ModerationSubjectAnonymized int64
	ModerationSubjectRetained   int64

	ReboundSubsRetained int64
}

// RoomChanges is what ScrubRoom changed in one room.
type RoomChanges struct {
	// Present is true when the person's sub or client id was in the room
	// before the scrub. It scopes display-name matching to that room.
	Present      bool
	QueueEntries int
	Votes        int
	HostCleared  bool
}

// Changed reports whether the room was modified.
func (c RoomChanges) Changed() bool {
	return c.QueueEntries > 0 || c.Votes > 0 || c.HostCleared
}

// ScrubRoom removes the person from one room state and bumps Version once if
// anything changed. Name-only attribution (no user id, from rooms without
// room auth) is anonymized only when the person's sub or client id is present
// in the room: a display name alone is not an identity.
func ScrubRoom(s *queue.RoomState, req Request) RoomChanges {
	voterKeys := map[string]bool{"user:" + req.Sub: true}
	for _, c := range req.ClientIDs {
		voterKeys["client:"+c] = true
	}

	present := s.HostUserID == req.Sub
	for _, t := range s.Queue {
		if t.AddedByUserID == req.Sub {
			present = true
		}
	}
	for _, voters := range s.Votes {
		for _, v := range voters {
			if voterKeys[v] {
				present = true
			}
		}
	}

	ch := RoomChanges{Present: present}
	if s.HostUserID == req.Sub {
		s.HostUserID = ""
		ch.HostCleared = true
	}
	for i := range s.Queue {
		t := &s.Queue[i]
		switch {
		case t.AddedByUserID == req.Sub:
			t.AddedByUserID = ""
			t.AddedBy = RemovedName
			ch.QueueEntries++
		case present && req.Name != "" && t.AddedByUserID == "" && t.AddedBy == req.Name:
			t.AddedBy = RemovedName
			ch.QueueEntries++
		}
	}
	for trackID, voters := range s.Votes {
		kept := voters[:0]
		for _, v := range voters {
			if voterKeys[v] {
				ch.Votes++
				continue
			}
			kept = append(kept, v)
		}
		if len(kept) == 0 {
			delete(s.Votes, trackID)
		} else {
			s.Votes[trackID] = kept
		}
	}
	if ch.Changed() {
		s.Version++
	}
	return ch
}

// subjectReportSQL matches reports about the person, aliased r. $1 is the
// client id array, $2 the display name, $3 the rooms the person is known to
// have been in. Member reports carry the reported member's client id as
// subject_id and their display name as content; message reports carry
// "reported message from <name>" as the reason, optionally behind a
// "[category] " prefix (cmd/server/report.go, web ChatPanel).
//
// A client id is unique, so it matches anywhere. A display name is not: it
// only matches inside rooms where the person's sub or client id was found,
// or a requester naming someone else could reach reports about that person.
const subjectReportSQL = `(
	(r.subject_id <> '' AND r.subject_id = ANY($1::text[]))
	OR ($2::text <> '' AND r.room_id = ANY($3::text[]) AND (
		(r.kind = 'member' AND r.content = $2::text)
		OR (r.kind = 'message' AND (
			r.reason = 'reported message from ' || $2::text
			OR right(r.reason, length('] reported message from ' || $2::text)) = '] reported message from ' || $2::text
		))
	))
)`

// linkedSQL is true for a moderation row (aliased m) tied to a report about
// the person that is being kept: same room, same subject (client or message
// id). Those rows are part of the retained evidence.
const linkedSQL = `EXISTS (
	SELECT 1 FROM reports r
	WHERE r.room_id = m.room_id AND r.subject_id <> '' AND r.subject_id = m.subject_id
	AND ` + subjectReportSQL + `
)`

// personRoomsSQL lists rooms where the person is identified outside room
// state: reports they filed, moderation rows where they acted or were the
// subject, reports about their client ids. $1 sub, $2 client ids.
const personRoomsSQL = `
	SELECT room_id FROM reports WHERE reporter_sub = $1
	UNION SELECT room_id FROM reports WHERE subject_id <> '' AND subject_id = ANY($2::text[])
	UNION SELECT room_id FROM moderation_actions
	      WHERE actor_user_id = $1 OR (subject_id <> '' AND subject_id = ANY($2::text[]))`

// step is one statement of a run. query steps count rows (retained data);
// the others write and report RowsAffected.
type step struct {
	table string
	dst   *int64
	query bool
	sql   string
	args  []any
}

// Run erases the person inside one transaction. With apply false it runs the
// same statements and rolls back, so a dry run reports exactly what apply
// would do. Idempotent: a second apply changes nothing.
func Run(ctx context.Context, pool *pgxpool.Pool, req Request, apply bool) (Counts, error) {
	if err := req.Validate(); err != nil {
		return Counts{}, err
	}
	clientIDs := req.ClientIDs
	if clientIDs == nil {
		clientIDs = []string{}
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return Counts{}, fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx) // no-op after a commit

	// Rooms the person is identified in, gathered before anything changes:
	// they scope the display-name matches below.
	rooms := map[string]bool{}
	rows, err := tx.Query(ctx, personRoomsSQL, req.Sub, clientIDs)
	if err != nil {
		return Counts{}, fmt.Errorf("person rooms: %w", err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return Counts{}, fmt.Errorf("person rooms: %w", err)
		}
		rooms[id] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Counts{}, fmt.Errorf("person rooms: %w", err)
	}

	var c Counts
	tag, err := tx.Exec(ctx, `DELETE FROM spotify_tokens WHERE sub = $1`, req.Sub)
	if err != nil {
		return Counts{}, fmt.Errorf("spotify_tokens: %w", err)
	}
	c.SpotifyTokensDeleted = tag.RowsAffected()
	if err := scrubRooms(ctx, tx, req, clientIDs, rooms, &c); err != nil {
		return Counts{}, fmt.Errorf("rooms: %w", err)
	}
	roomIDs := make([]string, 0, len(rooms))
	for id := range rooms {
		roomIDs = append(roomIDs, id)
	}

	subj := []any{clientIDs, req.Name, roomIDs}
	var steps []step
	// Subject reports go first, so the moderation link check below sees only
	// the reports that are actually kept.
	if req.IncludeSubjectReports {
		steps = append(steps, step{"reports", &c.ReportsSubjectDeleted, false,
			`DELETE FROM reports r WHERE ` + subjectReportSQL, subj})
	} else {
		steps = append(steps, step{"reports", &c.ReportsSubjectRetained, true,
			`SELECT count(*) FROM reports r WHERE ` + subjectReportSQL, subj})
	}
	steps = append(steps, []step{
		{"reports", &c.ReportsReporterAnonymized, false,
			`UPDATE reports SET reporter_sub = '' WHERE reporter_sub = $1`, []any{req.Sub}},
		// Acting as host is not evidence about the person: always anonymized.
		{"moderation_actions", &c.ModerationActorAnonymized, false,
			`UPDATE moderation_actions SET actor_user_id = '' WHERE actor_user_id = $1`, []any{req.Sub}},
		{"moderation_actions", &c.ModerationSubjectAnonymized, false,
			`UPDATE moderation_actions m SET subject_id = ''
			 WHERE m.subject_id <> '' AND m.subject_id = ANY($1::text[]) AND NOT ` + linkedSQL, subj},
		{"moderation_actions", &c.ModerationSubjectRetained, true,
			`SELECT count(*) FROM moderation_actions m
			 WHERE m.subject_id <> '' AND m.subject_id = ANY($1::text[]) AND ` + linkedSQL, subj},
		{"rebound_subs", &c.ReboundSubsRetained, true,
			`SELECT count(*) FROM rebound_subs WHERE sub = $1`, []any{req.Sub}},
	}...)

	for _, st := range steps {
		if st.query {
			if err := tx.QueryRow(ctx, st.sql, st.args...).Scan(st.dst); err != nil {
				return Counts{}, fmt.Errorf("%s: %w", st.table, err)
			}
			continue
		}
		tag, err := tx.Exec(ctx, st.sql, st.args...)
		if err != nil {
			return Counts{}, fmt.Errorf("%s: %w", st.table, err)
		}
		*st.dst = tag.RowsAffected()
	}

	if !apply {
		return c, nil // deferred rollback discards everything
	}
	if err := tx.Commit(ctx); err != nil {
		return Counts{}, fmt.Errorf("%w: %v", ErrCommitUnknown, err)
	}
	return c, nil
}

// ErrCommitUnknown wraps a failed commit: the transaction may or may not have
// been applied. Re-running is safe (the command is idempotent).
var ErrCommitUnknown = errors.New("commit failed, outcome unknown")

// scrubRooms rewrites every room whose state mentions the sub or a client id.
// The text match only picks candidates; ScrubRoom decides exactly, so a
// coincidental substring (a track title) is read and left alone. updated_at
// is deliberately not touched: an erasure must not restart the room's idle
// retention clock. Rooms where the person was present are added to rooms.
func scrubRooms(ctx context.Context, tx pgx.Tx, req Request, clientIDs []string, rooms map[string]bool, c *Counts) error {
	rows, err := tx.Query(ctx, `
		SELECT room_id, state FROM rooms
		WHERE strpos(state::text, $1) > 0
		   OR EXISTS (SELECT 1 FROM unnest($2::text[]) AS cid WHERE strpos(state::text, cid) > 0)
		FOR UPDATE`, req.Sub, clientIDs)
	if err != nil {
		return err
	}
	type update struct {
		id    string
		state []byte
		ver   int64
	}
	var updates []update
	for rows.Next() {
		var id string
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return err
		}
		var s queue.RoomState
		if err := json.Unmarshal(raw, &s); err != nil {
			rows.Close()
			return fmt.Errorf("room %s: %w", id, err)
		}
		ch := ScrubRoom(&s, req)
		if ch.Present {
			rooms[id] = true
		}
		if !ch.Changed() {
			continue
		}
		out, err := json.Marshal(&s)
		if err != nil {
			rows.Close()
			return err
		}
		updates = append(updates, update{id: id, state: out, ver: s.Version})
		c.RoomsRewritten++
		c.QueueEntriesAnonymized += int64(ch.QueueEntries)
		c.VotesRemoved += int64(ch.Votes)
		if ch.HostCleared {
			c.HostsCleared++
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, u := range updates {
		if _, err := tx.Exec(ctx, `UPDATE rooms SET state = $2, version = $3 WHERE room_id = $1`,
			u.id, u.state, u.ver); err != nil {
			return err
		}
	}
	return nil
}
