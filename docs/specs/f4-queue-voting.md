# F4: Queue voting

Issue: #130 (https://github.com/LucasSantana-Dev/cojam/issues/130)
Status: spec, ready for implementation
Date: 2026-07-22
Scope note: docs/specs/ is internal-only by repo convention (like docs/rfc/, docs/adr/); do not commit.

## 1. Goal and non-goals

Goal: listeners upvote queued tracks; every member sees live vote counts; the
host keeps full control of actual order. Smallest useful version: per-track
vote count, one vote per voter per track (toggle), host curates.

Decision: votes are a reorder SUGGESTION, not an automatic reorder.

- Queue order is host-authoritative today: `queue.reorder` is in
  `hostOnlyMethods` (`apps/server/internal/hub/hub.go:208-218`). Automatic
  vote-driven reordering would take ordering away from the host, which the
  issue explicitly forbids ("host keeps control").
- Auto-reorder per vote also costs a full-state publish plus a Version bump
  for every toggle and is unstable under ties (a freshly added track at 0
  votes would sink below every older track; flip-flopping around ties
  re-sorts the visible queue under the host's cursor).
- A visible count plus a "listeners' pick" marker delivers the signal without
  touching ordering semantics. The host applies the existing
  `queue.reorder` to act on it.

Non-goals:

- No automatic reordering, veto, or skip-by-votes (future variant; the data
  model here does not preclude it).
- No downvotes, no per-user vote history, no vote expiry.
- No changes to `now_playing.*` semantics; voting never moves the play head.

## 2. Protocol changes (`packages/shared/src/protocol.ts`)

### 2.1 RoomState addition: a separate votes map, NOT a TrackRef field

```ts
export type RoomState = {
  // ...existing fields...
  votes?: { [trackId: string]: string[] };  // trackId -> voter keys
};
```

Decision: `RoomState.votes` map, not `TrackRef.votes`.

- Trust boundary: `TrackRef` is client-supplied on `queue.add` /
  `playlist.import` and scrubbed by `validateImportTracks`
  (`apps/server/internal/hub/hub.go:38-73`). A votes field on it would need
  new validation plus server-side clearing (the `addedByUserId` pattern,
  hub.go:651) on every add path. A separate map leaves `TrackRef` and the
  validator untouched.
- Cleanup locality: pruning the map on track removal is one line in the
  hub's `queue.remove` closure (or in `queue.RoomState.Remove`); either way
  the lifecycle is explicit and testable.
- Version-bump cost does not decide this: every accepted mutation publishes
  the full `RoomState` (`docs/protocol.md:56`), so both placements pay the
  same per-vote publish. Persistence is also identical (the store marshals
  whole `RoomState`, `apps/server/internal/store/store.go:17-27`), so both
  survive restart. The deciding factors are the trust boundary and cleanup.
- Wire size at room scale is fine: cap voters per track (see 3.3).

Voter key: `user:<userID>` when the connection has an authenticated userID
(anonymous room-auth sub or `sb:<uuid>`), else `client:<clientID>`. This is
exactly `rateLimitKey` (`apps/server/internal/hub/hub.go:1197-1202`), so the
server stamps identity; clients never send who they are.

### 2.2 New RPC method

| method | params | result | authz | Version bump |
|---|---|---|---|---|
| `queue.vote` | `{ roomId: string, trackId: string }` | `RoomState` | member (NOT host-only) | yes |

- Toggle semantics: voter absent from `votes[trackId]` -> append (vote on);
  present -> remove (vote off). Idempotent per voter; no separate unvote RPC.
- Errors: unknown `trackId` -> `UserError("track not found")` style message
  (mirrors `queue.Remove`, `apps/server/internal/queue/queue.go:90`); missing
  `roomId` -> dispatch error like the other queue methods.
- Response is the full `RoomState` per convention; clients also receive the
  `room.state` publication, so the RPC result can be ignored by the store
  (same as `queue.add` in `apps/web/lib/realtime.ts:260-263`).
- Version bump is mandatory in the mutate closure (AGENTS.md gotcha #2): the
  web `setState` guard (realtime.ts:37-39) drops non-newer versions, so a
  vote without a bump would be invisible until reload.

## 3. Server design (`apps/server`)

### 3.1 State (`apps/server/internal/queue/queue.go`)

- `RoomState` gains `Votes map[string][]string` (json `votes,omitempty`).
- New method `ToggleVote(trackID, voter string) (voted bool, err error)`:
  unknown track -> error; else toggle membership in the set and bump
  `Version` only when the set actually changed.
- `Remove` (queue.go:78-91) also deletes `rs.Votes[trackID]` so counts die
  with the track. No prune needed on `AdvanceAfter`: tracks stay in the queue
  after playing, so their votes stay valid.
- Persistence: automatic via the store's whole-state marshal. Votes survive
  restart, which is desirable for long-lived rooms. Note: anonymous
  `client:<id>` votes persist but that voter cannot unvote after reconnecting
  (new clientID); accepted v1 limitation, counts stay honest for authed users.

### 3.2 Hub changes (`apps/server/internal/hub/hub.go`)

- `mutatingMethods` (hub.go:190): add `queue.vote` (membership-gated).
- NOT in `hostOnlyMethods`: voting is the listener's input channel; gating it
  to the host would defeat the feature.
- `dispatch` case `queue.vote`: parse `{roomId, trackId}`, then
  `h.mutate(roomID, func(s) { return s.ToggleVote(trackID, voter) })`.
- Voter identity plumbing: `dispatch` currently receives only `userID`
  (hub.go:599). Thread the already-computed `rlKey` from `handleRPC`
  (hub.go:553) into `dispatch` (internal signature change) and use it as the
  voter key. No transport changes; `RegisterClient` is untouched.
- Feature flag: `WithVoting(enabled bool)` on Hub, wired in
  `cmd/server/main.go` behind `featureEnabled("FEATURE_QUEUE_VOTING", false)`,
  default off (dark-ship, like `FEATURE_SYNC`). Off -> the case returns
  `centrifuge.ErrorMethodNotFound` (precedent: `transport.*`, hub.go:1052).

### 3.3 Rate limiting and caps

Each vote fans out a full-state publication to the room, and toggle wars are
cheap to start, so votes get their own bucket reusing the existing
`rateLimiter` (`apps/server/internal/hub/ratelimit.go`):

- New Hub field `voteLimiter *rateLimiter`, `newRateLimiter(10, 2*time.Second,
  time.Now)` in `NewHub`; new `voteMethods = map[string]bool{"queue.vote": true}`
  checked in `handleRPC` next to `checkFanoutLimit` (hub.go:587-597), keyed by
  `rlKey`. Rejection -> `userErrorf("too many requests, slow down")`.
- Keep it out of `fanoutMethods`: that budget protects third-party API quotas
  (ratelimit.go:8-10); votes never leave the server.
- Defensive cap: 200 voters per track (same spirit as `maxImportTracks`,
  hub.go:24). On overflow, `ToggleVote` returns a UserError. Rooms are small;
  this only stops abuse.
- One vote per voter per track is structural (set semantics), not a separate
  check.

## 4. Web design (`apps/web`)

### 4.1 Feature flag (runtime, per RFC-0006 / #126)

- `apps/web/lib/features.ts`: add `queueVoting`, env
  `NEXT_PUBLIC_FEATURE_QUEUE_VOTING`, default false.
- Runtime: `COJAM_FEATURE_QUEUE_VOTING` via `/env.js`, consumed through
  `useRuntimeFeatures()` if #126 has landed, otherwise the existing one-off +
  `useSyncExternalStore` pattern (see F1 spec section 4.1 for the exact
  references) and migrate with #126.

### 4.2 Store and RPC (`apps/web/lib/realtime.ts`)

- `voteTrack(roomId: string, trackId: string)` wrapper, following
  `queueRemove` (realtime.ts:274-277).
- Store additions: `myVotes: Record<string, true>` and
  `markVoted(trackId, voted: boolean)`, updated ONLY on RPC success. Rationale:
  the published `votes` map holds voter keys the client cannot map back to
  itself (the anonymous clientID is server-assigned), so the local set drives
  the pressed-state highlight while the server stays authoritative for counts.
  Limitation: `myVotes` resets on full reload; a stale highlight self-corrects
  on the next click because the server toggles (documented, acceptable v1).
- Counts come from `state.votes?.[trackId]?.length ?? 0`; no derivation
  helpers needed beyond that.

### 4.3 Components

- `apps/web/app/room/components/QueuePanel.tsx`: per-row upvote button
  (reuse the existing icon button styling in the row controls,
  QueuePanel.tsx:228-269) with the count next to it; pressed state from
  `myVotes`; errors surfaced through the existing `actionError` +
  `rpcErrorMessage` path (QueuePanel.tsx:36,52). Visible to every member
  regardless of `canControl` (voting is the listener control); disabled while
  disconnected.
- "Listeners' pick": the queued track (excluding `nowPlayingId`) with the
  highest count > 0 gets a small marker in the row. Pure render-side
  derivation, no server support.
- No changes to `apps/web/app/room/[id]/client.tsx` beyond passing the flag
  through if needed; `QueuePanel` already receives `roomId`.
- Guests vote exactly like account users (voter key falls back to clientID),
  consistent with the room-auth model (`docs/protocol.md:32-52`).

## 5. Edge cases and failure modes

- Voting on the now-playing track: allowed; the count is harmless signal and
  the track cannot be reordered anyway (`queue.reorder` is host-only).
- Track removed: votes pruned in `Remove`; no orphan counts after rejoin.
- Track removed and re-added: new server-assigned track id, votes start at 0.
- Disconnect/reconnect: the B10 rejoin resync (realtime.ts:162-171) returns
  the full state including `votes`; counts heal automatically. `myVotes`
  highlight is lost on full reload (see 4.2).
- Toggle war between two voters: each toggle is one publish; the vote limiter
  throttles each voter independently; last toggle wins, count stays correct.
- `FEATURE_ROOM_AUTH` off: all voters are `client:<id>`; everything works,
  with the unvote-after-reconnect limitation noted above.
- Flag off server-side, on client-side (misconfig): `voteTrack` rejects with
  MethodNotFound; `rpcErrorMessage` shows a generic failure inline. Acceptable;
  both flags are operator-set.
- Rate limited: the RPC rejects with the 400 UserError; the row shows the
  inline error and the highlight does not change (no optimistic update).

## 6. Acceptance criteria (mapped to verify commands)

Server (`cd apps/server && go test -race ./...`, `go vet ./...`):

- Extend `apps/server/internal/queue/queue_test.go`: `ToggleVote` adds,
  removes on second call, rejects unknown track, bumps `Version` only on
  change; `Remove` prunes the track's votes.
- New `apps/server/internal/hub/hub_vote_test.go`:
  - Non-member `queue.vote` rejected with PermissionDenied (mutatingMethods).
  - A non-host member CAN vote when a host is set (not host-only).
  - Version bump asserted on the mutation (gotcha #2).
  - One vote per voter: same voter twice = toggle off, count back to 0; two
    distinct voter keys = count 2.
  - Votes survive a store save/load round-trip (follow `hub_persist_test.go`).
  - Rejected after the limiter burst (shrink in test like
    `hub_ratelimit_test.go:34`).
  - `WithVoting(false)` -> ErrorMethodNotFound.
- `go vet ./...` clean.

Web (`cd apps/web && npx tsc --noEmit`, `pnpm lint`, `npx vitest run`):

- Shared `RoomState.votes` type compiles workspace-wide.
- Unit: QueuePanel renders the vote button with the count, pressed state from
  `myVotes`, hidden with flag off; `markVoted` only on RPC success (mock the
  realtime module, existing vitest patterns in `app/room/components/*.test.tsx`).
- e2e (`pnpm --filter web e2e` only, never raw playwright on :3000): with the
  flag on, voting a queued track increments the visible count and a second
  click decrements it.
