# RFC-0001: Room State Persistence (Postgres)

Status: Proposed (decomposition only; execution gated on approval)
Pipeline: ralphinho-rfc-pipeline
Complements: ADR-0001 (MVP stack)

## 1. RFC intake

### Problem
Room state (`queue.RoomState`) lives only in the hub's in-memory
`rooms map[string]*Room`. A server restart, crash, or redeploy drops every
active room: queue, now-playing, and radio flag are all lost. `README.md` lists
this as the MVP shippability blocker ("In-memory rooms (MVP) · PostgreSQL
planned"), and `docs/deploy.md` carries a Fly Postgres placeholder.

### Goals
- Room state survives server restart / redeploy.
- Zero behavior change when `DATABASE_URL` is unset (dev + CI stay in-memory).
- No new blocking dependency in the hot path beyond one keyed upsert per mutation.
- Multi-instance-safe writes (future horizontal scale) without a distributed lock.

### Non-goals
- Normalized relational schema (tracks / sources tables). Deferred, see Decision.
- Per-user listening history, analytics, or cross-room queries.
- Playback-position persistence (belongs to the synchronized-playback RFC).

### Decision: snapshot JSONB, not a normalized schema
`RoomState` is already an atomic, versioned, JSON-marshaled blob: `hub.mutate()`
marshals the whole struct under the room lock and publishes it wholesale, and it
carries a monotonic `Version int64`. Persisting it as a single `jsonb` column
keyed by `room_id`, guarded by that version, mirrors the code that already
exists and adds one table and zero joins.

A normalized `tracks` / `sources` schema would add migration surface, join
complexity, and an object-relational mapping layer for no MVP benefit: nothing
queries *across* rooms or *inside* a queue at the DB level. The whole state is
read and written as a unit. Reserve normalization for when a real cross-room
query appears (revisit trigger recorded below).

Concurrency: `INSERT ... ON CONFLICT (room_id) DO UPDATE ... WHERE
excluded.version > rooms.version`. The per-room mutex serializes writers
in-process today; the version guard makes a stale write a no-op, which is what
lets a `Save` run *after* the lock is released (see U4) and keeps two instances
from clobbering each other later.

### Revisit when
A feature needs to query across rooms or inside a queue at the DB layer
(e.g. "resume the room I was in", global search, per-track analytics). At that
point, promote the JSONB blob to a normalized schema behind the same `Store`
seam introduced in U1.

## 2. DAG decomposition

```
        U1 (Store seam + in-mem)      U2 (schema + pgx + config)
                 \                        /
                  \                      /
                   v                    v
                    U3 (Postgres Store impl)
                             |
                             v
                    U4 (hub integration)
                             |
                             v
                    U5 (deploy wiring + docs)
```

- U1 and U2 are independent and run in parallel (wave 1).
- U3 depends on both (needs the interface from U1 and the pool/schema from U2).
- U4 depends on U3. U5 depends on U4.

## 3. Unit specs

### U1 — Store seam + in-memory adapter
- id: `U1`
- depends_on: []
- scope: Define `store.Store` interface (`Load(ctx, roomID) (*queue.RoomState,
  error)`, `Save(ctx, *queue.RoomState) error`, sentinel `ErrNotFound`). Provide
  `store.Memory` implementing it over a mutex-guarded map. Refactor `hub` to hold
  a `Store` and route `GetOrCreateRoom` / `mutate` through it (in-memory adapter
  = current behavior, verified by the existing hub suite passing unchanged).
- acceptance_tests: existing `hub` + `queue` suites pass unchanged; new
  `store.Memory` round-trip test (Save then Load returns equal state; Load of an
  unknown room returns `ErrNotFound`).
- risk_level: Tier 2 (multi-file refactor, no external dep, behavior-preserving)
- rollback_plan: revert the unit; hub returns to the direct map. Self-contained.

### U2 — Schema, pgx pool, config
- id: `U2`
- depends_on: []
- scope: Add `jackc/pgx/v5` (+ pgxpool). New `db` package: parse `DATABASE_URL`,
  build a pool, `Ping` on startup, expose `Close`. Migration `0001_rooms.sql`:
  `rooms(room_id text primary key, state jsonb not null, version bigint not null,
  updated_at timestamptz not null default now())`. Pick a migration mechanism
  (embedded `golang-migrate` or a hand-rolled `migrate()` that runs `.sql` files
  from an `embed.FS` — decide in the unit's plan step, prefer the smallest thing
  that runs on boot).
- acceptance_tests: `db` unit test against a throwaway Postgres (testcontainers
  or a `TEST_DATABASE_URL` skip-guard) opens a pool, runs the migration, and
  confirms the `rooms` table + columns exist; pool build with an empty/invalid
  URL returns a typed error, not a panic.
- risk_level: Tier 3 (new infra dep, schema, migration path)
- rollback_plan: feature stays dark while `DATABASE_URL` is unset (U4 gates on
  it); revert drops the dep and migration with no runtime consumer yet.

### U3 — Postgres Store implementation
- id: `U3`
- depends_on: [U1, U2]
- scope: `store.Postgres` implementing `Store` over the U2 pool. `Load` = `SELECT
  state FROM rooms WHERE room_id=$1` → unmarshal (`ErrNotFound` on no rows).
  `Save` = the version-guarded upsert from the Decision. Marshal/unmarshal via
  the existing `RoomState` JSON tags (no separate DTO).
- acceptance_tests: round-trip parity with `store.Memory` (same interface test
  table runs against both); `Save` of a lower `Version` after a higher one does
  not overwrite (stale-write rejected); `Load` after `Save` returns byte-equal
  queue ordering and `NowPlayingID`.
- risk_level: Tier 2 (isolated behind the interface; the interface is the test
  surface)
- rollback_plan: revert; `Memory` remains the only adapter. No schema change.

### U4 — Hub integration + graceful degradation
- id: `U4`
- depends_on: [U3]
- scope: Wire the chosen `Store` in `cmd/server/main.go` (Postgres when
  `DATABASE_URL` set, else `Memory` — same graceful-gate pattern as the
  providers). `GetOrCreateRoom` loads from the store on first touch (miss →
  fresh room). `mutate` persists after `fn` applies: marshal under the room lock
  (already done), release, then `Save` the resulting state so a DB round-trip
  never blocks other rooms; the version guard keeps out-of-order saves safe.
  A `Save` error is logged + metered, never fails the RPC (availability over
  durability for a single write; the next mutation re-persists).
- acceptance_tests: with a test Postgres, add tracks to a room, drop the hub, new
  hub `GetOrCreateRoom` returns the same queue + now-playing; with no
  `DATABASE_URL`, the full existing suite passes (in-memory); a forced `Save`
  error surfaces in logs/metrics and the RPC still returns the new state;
  concurrent mutations converge to the highest `Version` in the row.
- risk_level: Tier 2 (hot-path change, but additive and gated)
- rollback_plan: unset `DATABASE_URL` (instant runtime fallback to in-memory) or
  revert the wiring commit. The store seam stays.

### U5 — Deploy wiring + docs
- id: `U5`
- depends_on: [U4]
- scope: `flyctl postgres create` + attach (sets `DATABASE_URL` secret); run the
  migration on deploy (release_command or boot migrate). Update `docs/deploy.md`
  (replace the placeholder), `README.md` persistence row, and `.env.example`.
  Add a `/readyz` DB-ping check distinct from `/healthz` if cheap.
- acceptance_tests: staging deploy comes up with `DATABASE_URL` set and logs a
  successful migration + pool ping; a room created before a redeploy is present
  after it; `docs/deploy.md` no longer says "placeholder".
- risk_level: Tier 2 (ops; provisioning is operator-gated — secrets/DB creation
  are T3 and stay with the human)
- rollback_plan: detach the DB / unset the secret → in-memory; the app still
  boots. Docs revert independently.

## 4. Unit scorecards

| Unit | Tier | Integration risk | Rough effort | Parallelizable |
| --- | --- | --- | --- | --- |
| U1 Store seam | 2 | Low (behavior-preserving) | S | wave 1 |
| U2 Schema + pgx | 3 | Medium (new dep + migration) | M | wave 1 |
| U3 Postgres Store | 2 | Low (behind interface) | S | after U1+U2 |
| U4 Hub integration | 2 | Medium (hot path, gated) | M | after U3 |
| U5 Deploy + docs | 2 | Medium (ops, operator-gated) | S | after U4 |

## 5. Integration risk summary

- **Hot-path latency** (U4): persisting inside `mutate` adds a DB round-trip per
  mutation. Mitigated by saving *after* releasing the room lock and never
  failing the RPC on a save error. Watch p99 mutation latency post-cutover.
- **Stale / out-of-order writes** (U3/U4): version-guarded upsert makes a late
  save a no-op; correctness does not depend on save ordering.
- **Migration on deploy** (U2/U5): a failed migration must fail the deploy
  loudly, not silently boot on an old schema (prior incident class:
  `docs/failures`). Acceptance test asserts the migration log line.
- **Dev/CI drift** (U1/U4): the in-memory path must stay the default with no
  `DATABASE_URL`, or CI starts requiring a Postgres. Guarded by the graceful
  gate + the existing suite passing unchanged in U1 and U4.
- **Operator boundary** (U5): DB provisioning and the `DATABASE_URL` secret are
  T3 — created by the operator, never by an agent.

## 6. Merge queue order

`U1, U2` (parallel) → `U3` → `U4` → `U5`. Rebase each unit branch on the
integration branch before merge; re-run `go test -race ./...` after each queued
merge; never merge a unit with an unresolved upstream dependency.
