# 166: Proactive host handoff on disconnect

Issue: #166 (https://github.com/LucasSantana-Dev/cojam/issues/166)
Parent: #139
Status: spec, ready for implementation
Date: 2026-08-01
Scope note: internal design doc, committed alongside docs/rfc/ and docs/adr/ (precedent: PR #146).

## 1. Goal and non-goals

Goal: when the host disconnects, the server immediately promotes the longest-present
remaining authenticated member to host, bumps `RoomState.Version`, and broadcasts, so
connected clients gain host controls without a reload. An empty room needs no promotion
and must not error.

Decision: promotion runs in the centrifuge disconnect hook, before membership is cleared.

- Host handoff today is lazy only. It happens inside the `room.join` case at
  `apps/server/internal/hub/hub.go:840-843`, which claims host when the current
  `HostUserID` is no longer present in the room. If the host closes their tab, the
  remaining members sit in a room with no transport, no queue reorder, and no
  now-playing control until somebody rejoins.
- Guest-hosted rooms are the likely failure. A casual listener closes a tab, playback
  control dies, and nobody present can fix it.
- Proactive promotion closes that window inside a single publish cycle.

Non-goals:

- No vote-based host election or role demotion.
- No inactivity-based reclaim. This spec covers disconnect only.
- No host signalling in presence events. Presence is ephemeral; host role is persisted
  state on `RoomState`.

## 2. Ordering constraint in the disconnect hook

The disconnect hook is `apps/server/cmd/server/main.go:426-431`:

```go
client.OnDisconnect(func(e centrifuge.DisconnectEvent) {
    metrics.ConnDec()
    h.Leave(client.ID())              // revoke room memberships for this connection
    h.RemoveClientUserID(client.ID()) // clean up userID tracking for host assignment
    logger.Info("client_disconnected", "client_id", client.ID(), "reason", e.Reason)
})
```

Promotion must run FIRST, before `h.Leave` and `h.RemoveClientUserID`:

```go
client.OnDisconnect(func(e centrifuge.DisconnectEvent) {
    metrics.ConnDec()
    h.PromoteOnDisconnect(client.ID()) // must precede the two cleanup calls
    h.Leave(client.ID())
    h.RemoveClientUserID(client.ID())
    logger.Info("client_disconnected", "client_id", client.ID(), "reason", e.Reason)
})
```

Rationale: `PromoteOnDisconnect` needs two things that the cleanup calls destroy. It needs
`h.clientUserID[clientID]` (hub.go:252, cleared by `RemoveClientUserID` at hub.go:418-420)
to know which userID just left, and it needs the room membership list to know which rooms
that client belonged to (cleared by `h.Leave`). Ordering it after the cleanup would require
re-deriving both, which is why this is a hard sequencing requirement and not a preference.

## 3. Determining longest-present

The hub tracks membership (`h.members`, guarded by `memberMu`) and authenticated identity
(`h.clientUserID`, hub.go:252), but it does not track when a member joined. That state has
to be added; there is nothing existing to reuse.

Smallest addition: a per-room map of userID to join timestamp, guarded by the existing
`memberMu` so it shares the lock that already protects membership and needs no new lock
ordering.

```go
// memberJoinTimes records when each authenticated userID most recently joined each
// room, for longest-present promotion on host disconnect. Guests (empty userID) are
// not tracked: they cannot hold the host role under RFC-0005. Guarded by memberMu.
memberJoinTimes map[string]map[string]int64 // roomID -> userID -> unix nanos
```

Recorded in the `room.join` dispatch case, alongside the existing host assignment at
hub.go:835-848. A reconnect resets the timestamp to now, so a member who drops and returns
loses seniority. That is the correct reading of "longest present": it measures continuous
presence, not cumulative history.

Cleanup: `evictIdleRooms` (hub.go:626-646) already deletes rooms from `h.rooms` when they
are memberless past `roomIdleTTL`. Delete the room's `memberJoinTimes` entry in the same
loop, so the two lifetimes stay identical and the map cannot leak.

## 4. Promotion logic

```go
// PromoteOnDisconnect promotes a new host in every room where the disconnecting client
// held the host role. Must be called BEFORE h.Leave and h.RemoveClientUserID (see §2).
// No-op for guests and for clients that held no host role.
func (h *Hub) PromoteOnDisconnect(clientID string)
```

Behavior, in order:

1. Resolve the leaving `userID` from `h.clientUserID[clientID]`. Empty means a guest, which
   cannot be host under RFC-0005, so return immediately.
2. For each room the client was a member of, read `RoomState.HostUserID`. Skip rooms where
   it does not equal the leaving userID. This is the common case and must stay cheap.
3. Exclude `clientID` from the membership check. `PromoteOnDisconnect` runs before
   `h.Leave`, so `hasMembersLocked` (hub.go:650-657) still counts the departing client;
   an unfiltered check would never see the room as empty and could reselect the departing
   host. If no other member remains, return without mutating. The room will be reaped by
   `evictIdleRooms`.
4. Select the remaining member other than `clientID` with the smallest
   `memberJoinTimes[roomID][userID]`. Skip clients whose `clientUserID` entry is empty,
   since guests are not eligible.
5. If no authenticated member remains (an all-guest room), clear `HostUserID` to the empty
   string. This restores the pre-host equal-member behavior rather than leaving a dangling
   pointer to a departed user.
6. Apply through the existing `h.mutate` path so the Version bump and publish follow the
   established convention (AGENTS.md gotcha 2). Re-check inside the closure that
   `HostUserID` still equals the leaving userID, so a concurrent promotion cannot be
   overwritten. The closure also revalidates the selected successor: membership and
   authenticated identity are re-read at commit time, and if the candidate disconnected or
   lost its authenticated identity between selection and mutation, the closure aborts
   without mutating. The candidate's own disconnect hook (or the next join's lazy reclaim)
   then runs the promotion again, so a departed user is never persisted as host.

Locking: acquire `memberMu` for the membership and join-time reads, release before calling
`h.mutate`, which takes the room lock. Do not hold `memberMu` across `mutate`. Holding both
inverts the order used by `evictIdleRooms` (memberMu then h.mu) only if mutate is called
while memberMu is held, so releasing first is what keeps the ordering consistent.

## 5. Interaction with the existing lazy reclaim

The lazy path at hub.go:840-843 claims host when
`!h.IsUserIDInRoom(req.RoomID, s.HostUserID)` (hub.go:424). With proactive promotion, the
new host is already set and is present, so the lazy check evaluates false and does nothing.
No double-promotion.

The lazy path stays as the safety net. It covers the two cases proactive promotion cannot:
a room that was empty at disconnect time and is later rejoined, and any promotion lost to a
server restart (see §6).

## 6. Edge cases and failure modes

- Empty room at disconnect: no promotion, no mutation, no Version bump. `evictIdleRooms`
  reaps the room after `roomIdleTTL`.
- All-guest room: `HostUserID` cleared to empty. Room behaves as equal-member, matching
  behavior before room-auth existed.
- Host disconnects while another member is mid-join: the disconnect hook completes first at
  the centrifuge layer, so the joining member's `room.join` observes the already-promoted
  host and its lazy check is a no-op.
- Two members disconnect simultaneously, one of them the host: each invocation re-checks
  `HostUserID` inside the mutate closure, so only the one that still matches applies a
  change. The other is a no-op.
- Promoted host then disconnects: the same path runs again and promotes the next member.
  Chains correctly.
- Server restart: `memberJoinTimes` is in-memory only and is lost. `HostUserID` persists via
  the store. On restart the first authenticated joiner triggers the lazy reclaim, which is
  the same behavior as a cold boot. Join times rebuild as members join.
- `FEATURE_ROOM_AUTH` off: `HostUserID` is never set, so step 2 never matches and the whole
  path is a no-op. No separate flag needed.

## 7. Feature flag

Ships on by default, gated implicitly by `FEATURE_ROOM_AUTH`.

The dark-ship convention at `apps/server/cmd/server/main.go:106-109` applies to features
that add new user-visible surface (`FEATURE_SYNC`, `FEATURE_QUEUE_VOTING`,
`FEATURE_ROOM_CHAT`, `FEATURE_PUBLIC_ROOMS`). This adds no RPC and no UI. It corrects
existing behavior that is already broken, and it degrades to the current lazy path if it
never fires. A flag would mean shipping a known room-death bug behind an off switch.

## 8. Web changes

None. Promotion publishes the full `RoomState` through the standard mutate path, and the
Version bump makes the web store accept it (the `setState` guard drops non-newer versions).
Host-only controls already derive from the room state, so they light up on the new host
without a reload.

## 9. Acceptance criteria (mapped to verify commands)

Server (`cd apps/server && go test -race ./...`, `go vet ./...`):

- New `apps/server/internal/hub/hub_handoff_test.go`:
  - Host disconnects from a room with two other authenticated members: the one with the
    earlier join time becomes host, Version bumps exactly once.
  - Host disconnects from an empty room: no mutation, no Version bump, no error.
  - Host disconnects from an all-guest room: `HostUserID` is cleared to empty.
  - Non-host disconnects: no mutation, no Version bump.
  - Guest disconnects: no mutation (empty userID short-circuits).
  - Reconnect resets seniority: member A joins, member B joins, A reconnects, host
    disconnects, B is promoted (not A).
  - Concurrent: two disconnects processed against the same room produce exactly one
    promotion.
  - Concurrent: the host and the selected successor disconnect together; the commit-time
    revalidation in step 6 aborts the stale promotion, and the departed successor is never
    persisted as `HostUserID`.
  - Chained: promoted host disconnects, the next member is promoted.
  - Lazy reclaim at hub.go:840-843 is a no-op after a proactive promotion (no
    double-promote).
- Extend `apps/server/internal/hub/hub_persist_test.go`: a promoted `HostUserID` survives a
  store save and load round-trip.
- Race detector clean under `-race` with concurrent join, leave, and disconnect.
- `go vet ./...` clean.

Web (`cd apps/web && npx tsc --noEmit`, `pnpm lint`, `npx vitest run`):

- No changes expected. The suites must stay green.

E2E (`pnpm --filter web e2e` only, never raw playwright on :3000):

- Two-browser scenario. Alice opens a room as an authenticated user and is host. Bob joins
  as an authenticated user. Alice closes her tab. Bob's page receives the state publication
  and host-only controls become enabled without a reload, and Bob can then use them.
