# 169: Evict idle zero-member rooms from Postgres

Issue: #169 (https://github.com/LucasSantana-Dev/cojam/issues/169)
Status: spec, ready for implementation
Date: 2026-08-01
Scope note: internal design doc, committed alongside docs/rfc/ and docs/adr/ (precedent: PR #146).

## 1. Goal and non-goals

Goal: delete persisted room snapshots that have been memberless and untouched beyond a
configurable TTL, so the `rooms` table stops growing without a ceiling. Every room any guest
ever created currently persists forever with its queue.

This is slow-burning, not urgent, which is why it is ranked last. It is specified now
because the failure mode is unbounded and the fix is small.

Non-goals:

- No soft delete and no audit table. The store keeps no history today, and adding one to
  record deletions of abandoned rooms inverts the point of the feature.
- No cascade. Queue, votes, and chat all live inside the `state` JSONB column and are
  removed with the row.
- No storage-pressure heuristics or adaptive TTL.

## 2. There is already an evictor, and this extends it

The hub already evicts idle rooms from memory. `StartRoomEvictor` at
`apps/server/internal/hub/hub.go:597` runs on a ticker at `roomIdleTTL / 2` (hub.go:601),
and `evictIdleRooms` at hub.go:626-646 drops rooms from `h.rooms` when
`hasMembersLocked` (hub.go:650) reports none and `roomIdleTTL` has elapsed.

This slice adds a persistent sweep to that existing loop rather than introducing a second
scheduler. One ticker, one shutdown path, one place to reason about eviction. A separate
goroutine would double both the lifecycle and the chance of the two notions of idleness
drifting apart.

Critically, this does **not** introduce a second definition of idle. In-memory eviction
answers "should this room stay resident". The persistent sweep answers "should this row
still exist". They are different questions with different horizons, and conflating them is
what would be wrong. The persistent TTL is expected to be much longer than the in-memory
one, and is configured independently.

## 3. What "idle" means in the store

The `rooms` table is:

```sql
CREATE TABLE IF NOT EXISTS rooms (
    room_id    text        PRIMARY KEY,
    state      jsonb       NOT NULL,
    version    bigint      NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
```

`updated_at` is set on every write, so it is already the idleness marker and no migration is
needed. A room with no mutations has a frozen `updated_at`.

Note that in-memory activity does not touch it. A room can be resident and recently read
while its row is months old, because reads do not write. That is the correct behavior for a
storage-retention decision: a room nobody has changed is stale regardless of who is looking
at it. Membership, not read activity, is what protects a row from deletion.

## 4. Not deleting live rooms

This is the part that must not be wrong, because the failure is silent and destructive.

Two states are dangerous if handled naively:

- A row exists but the room is not resident in `h.rooms`. This is normal after in-memory
  eviction or after a restart, and such a room is a legitimate deletion candidate once its
  TTL passes.
- A room is resident and has connected members while its row is old. This row must never be
  deleted, and `updated_at` alone would not protect it.

So the sweep is membership-gated, not timestamp-gated alone. Before deleting, it collects
the set of room ids that currently have members according to `hasMembersLocked`, and
excludes them from the delete regardless of how old their rows are.

The exclusion is passed explicitly to the store rather than left implicit. A store method
that deletes by timestamp with no membership input is a loaded gun for any future caller, so
the store refuses to run without being told what to protect. Passing an empty exclusion set
is a legitimate answer (no rooms have members), but it must be passed deliberately rather
than defaulted.

Ordering: a member who joins between the snapshot and the delete is safe. Joining writes the
room, which advances `updated_at` past the cutoff, so the row no longer matches. A member
who joins a room the sweep is about to delete therefore loses at worst a row that is
immediately recreated on the next save, with no data the member could observe.

## 5. Config

New env var alongside the existing room TTL handling in `apps/server/cmd/server/main.go`,
following the same parsing convention already used there.

- Value is a duration in minutes.
- Unset, invalid, or non-positive disables persistent eviction entirely, matching how
  `roomIdleTTL` guards itself at hub.go:598 and hub.go:627.
- Default: disabled. This is a destructive background job on the operator's only database,
  and defaulting it on would delete rooms on the next deploy without anyone opting in. The
  runbook can turn it on deliberately once a value has been chosen.

The persistent TTL should be set well above the in-memory TTL. The two are independent, and
setting the persistent one shorter would delete rows for rooms still resident, which the
membership gate would catch only while members are connected.

## 6. Store interface

The `Store` interface at `apps/server/internal/store/store.go:16` gains one method that
deletes rows older than a cutoff, excluding a caller-supplied set of protected room ids, and
returns how many rows it removed.

- The memory store implements it as a no-op returning zero. There is nothing to reclaim, and
  the in-memory evictor already handles residency.
- The Postgres store issues a single parameterized delete. The exclusion list is bound as
  parameters, never interpolated.
- Passing a nil exclusion set is an error, not an empty exclusion. See section 4.

An index on `updated_at` is not required at current scale, since the table is small and the
sweep is infrequent. Note it as the first thing to add if the sweep ever shows up in query
timing, rather than adding it speculatively now.

## 7. Observability

Metric: a counter named `music_jam_rooms_persisted_evicted_total`, following the existing
naming in `apps/server/internal/obs/obs.go` (`music_jam_connections_active`,
`music_jam_match_cache_hits_total`, `music_jam_rooms_active`). Registered the same way as
its neighbors and incremented by the number of rows removed.

Name the accessor method distinctly from the counter field it wraps. Reusing one identifier
for both does not compile in Go, and the existing metrics in that file already demonstrate
the correct shape.

Logging via the existing `log/slog` structured logger:

- One info event per non-empty sweep carrying the number of rows removed. Not one event per
  room: a sweep that reclaims a thousand abandoned rooms should be one line, not a thousand.
- One error event when the sweep fails, carrying the error. A failed sweep must not abort
  in-memory eviction or crash the ticker; it logs and the next tick retries.

## 8. Edge cases and failure modes

- Postgres unreachable or slow: the sweep is bounded by a timeout, logs, and returns. The
  in-memory evictor in the same tick is unaffected.
- Memory store configured: the no-op implementation runs and reclaims nothing.
- Persistent eviction disabled: the sweep returns immediately, before touching the store.
- Room recreated after deletion: a rejoin creates a fresh row with a current `updated_at`.
  Nothing observable is lost, because a memberless room past a long TTL had no live state.
- Concurrent instances: not applicable today (single container per
  `docs/runbooks/feature-rollout-plan.md`), and harmless if it ever changes, since the second
  delete simply affects zero rows.
- Mutation racing a delete: the room is memberless and past TTL, so no mutation is in flight.
  If one somehow arrives, the room is not found, is recreated at version zero, and persists
  normally.

## 9. Testing

Time is injected, never slept. The codebase already has the pattern: `newRateLimiter` takes
a time function, and `evictIdleRooms` at hub.go:626 takes `now time.Time` as a parameter
rather than reading the clock itself. The persistent sweep takes `now` the same way, so a
test calls it directly with an advanced timestamp and needs no ticker and no goroutine.

The safety test is the one that matters and must be written first:

A room whose row is far older than the TTL, with a connected member, is not deleted. This is
the test that fails if the membership gate is dropped, and it must be written so that
removing the gate makes it fail. Asserting only that some deletion happened would pass with
the gate removed, which is the failure mode of a test that looks thorough and proves nothing.

## 10. Acceptance criteria (mapped to verify commands)

Server (`cd apps/server && go test -race ./...`, `go vet ./...`):

- Store interface gains the delete method; the memory store returns zero and no error.
- The store method returns an error when given a nil exclusion set, asserted directly.
- Postgres implementation deletes rows older than the cutoff, skips excluded room ids, and
  returns an accurate count. Exclusion ids are bound as parameters.
- The persistent sweep runs from the existing evictor loop, after in-memory eviction, and is
  a no-op when the persistent TTL is non-positive.
- **Safety: a room with a connected member is never deleted, however old its row.** Written
  so that removing the membership gate makes this test fail.
- A memberless room past the persistent TTL is deleted.
- A memberless room inside the TTL is retained.
- A store error is logged and does not abort the tick or panic the evictor.
- Counter `music_jam_rooms_persisted_evicted_total` increases by the number of rows removed
  and is unchanged on an empty sweep.
- Time is injected in every test; no test sleeps.
- Race detector clean under `-race` with concurrent join, leave, mutation, and sweep.
- `go vet ./...` clean.

Config:

- The env var is documented alongside the existing room TTL setting, including that it is
  disabled by default and why.
