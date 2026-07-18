# RFC-0005: Room roles + authorization

Status: proposed (2026-07-18)
Pipeline: ralphinho-rfc-pipeline. Fifth RFC after 0001 persistence, 0002 sync, 0003 audiophile, 0004 Spotify activation.

## Summary

Today any client can mutate any room: skip, reorder, remove other people's tracks, drive
transport. There is no host. Worse, the foundation needed to fix it is missing: **client identity
is completely spoofable** (the web client connects with an empty token, the server accepts an
empty UserID, and "identity" is just a client-supplied name). A role gate built on that identity
would be theater, because a client can claim to be anyone.

This RFC establishes an *unforgeable, right-sized* identity and then a host/listener authorization
model on top of it. It deliberately does NOT build accounts, passwords, or OAuth: CoJam is a
trusted friend group joining by room code. The identity is a **server-issued signed connection
token** carrying an anonymous but stable `sub`, so the server can attribute every action to a
non-spoofable id without a login system.

Ships **DARK** behind `FEATURE_ROOM_AUTH` (server) + `NEXT_PUBLIC_FEATURE_ROOM_AUTH` (web), both
default OFF. When off, the current anonymous-equal behavior is unchanged.

## Threat model (what we are and aren't defending)

- **Are:** accidental stomping (any friend clicking skip/remove), casual griefing inside a
  semi-open room-code, "who's in charge" ambiguity.
- **Aren't:** authenticated user accounts, cross-device identity portability, defense against a
  determined attacker with the server secret. Anonymous-but-unforgeable-per-secret is the bar.

## Verified current state (2026-07-18)

| Piece | State | Evidence |
|---|---|---|
| Web connection token | **empty string** (`token: ''`) | `apps/web/lib/realtime.ts:104` |
| Server connect handler | accepts any connection, `UserID=""` (anonymous) | `apps/server/cmd/server/main.go:268-284` |
| Identity | client-supplied name in ConnInfo, unvalidated | `realtime.ts:100-105` |
| RPC dispatch identity | spoofable centrifuge connection UUID, no authenticated user | `hub.go:309+` |
| Authorize gate | membership only (`IsMember`), all members equal | `hub.go:173-198` |
| RoomState | no host/roles field; `TrackRef.AddedBy` is display-only | `queue.go:46-54,36` |
| Room lifecycle | implicit create on first join; no owner/creator; empty rooms orphaned | `hub.go:200-245,158-163` |
| Mutating methods | queue.add/remove/reorder, now_playing.set/advance, playlist.import, radio.set, transport.play/pause/seek | `hub.go:88-99` |
| protocol.md | already admits `now_playing.set` "(host only, v0: anyone)" | `docs/protocol.md:13` |

## Design

- **Identity:** a new `internal/connauth` package mints a signed connection JWT (HS256,
  `ROOM_AUTH_SECRET`) with an anonymous stable `sub`. Endpoint `GET /api/connection-token` returns
  `{token, userId}`. The web app persists `userId` in localStorage and reuses it on reconnect, so a
  refresh/rejoin keeps the same identity. Centrifuge validates the JWT on connect and sets
  `credentials.UserID = sub`. RPC handlers read the trusted `client.UserID()`. A client cannot
  present another user's `sub` without the server secret.
- **Roles:** binary **HOST** / **LISTENER** (no DJ tier in v1 - YAGNI; add later if demand).
  `RoomState.HostUserID` records the host. First authenticated joiner of a fresh room becomes host;
  it persists in the snapshot JSONB. Host-handoff: if the host is absent, a present member can
  **claim** an unheld room; the host may also reassign.
- **Gate:** `Authorize`/dispatch enforces host-only methods by the trusted UserID. LISTENERS keep
  `queue.add` (and remove of *their own* added tracks); HOST gets the disruptive set
  (now_playing.set/advance, reorder, remove-any, transport.*, radio.set).
- **Dark:** entire behavior gated by `FEATURE_ROOM_AUTH`. Off = today's behavior (empty token
  accepted, all members equal). On = signed identity required + role gate active.

## Work units

### U1 - Signed connection identity (server foundation) [WAVE 1, Tier 3, unblocker]
- **scope:** new `apps/server/internal/connauth` (HS256 mint + validate, `ROOM_AUTH_SECRET`);
  `GET /api/connection-token` endpoint; centrifuge `OnConnecting` validates the JWT and sets
  `credentials.UserID` from `sub`; thread the authenticated UserID into the RPC dispatch entry so
  handlers/Authorize can read it. **Feature-flagged**: when `FEATURE_ROOM_AUTH` is off, preserve
  today's empty-token/anonymous behavior exactly (back-compat, mergeable dark on its own). The web
  client half is U2, so this merges without breaking anything while the flag is off.
- **depends_on:** none. Blocks every later unit.
- **acceptance_tests:** with the flag on: a forged token (bad signature) is rejected; a valid token
  sets `UserID=sub`; the dispatch path receives the trusted UserID; an absent/expired token is
  rejected. With the flag off: connection with empty token still works (unchanged). Table/unit
  tests in `connauth` + a hub/connection test asserting UserID threading. `go test -race ./...`.
- **risk_level:** high (auth boundary; prod-only-config class of bug). Mitigated by the dark flag +
  back-compat path.
- **rollback_plan:** revert the single PR; flag never enabled; zero behavior change.

### U2 - Web auth client [WAVE 2, Tier 2] (depends U1)
- Fetch `/api/connection-token`, persist `userId` in localStorage, reuse on reconnect, send the JWT
  in the centrifuge `token` (`realtime.ts:104`). Behind `NEXT_PUBLIC_FEATURE_ROOM_AUTH`.

### U3 - Host + role model in RoomState [WAVE 3, Tier 3] (depends U1)
- Add `HostUserID` (and any role map needed) to RoomState (protocol + `queue.go`); first
  authenticated joiner becomes host on `GetOrCreateRoom`/join; persist in snapshot; host-handoff /
  claim-empty-room. Tests via the hub test client.

### U4 - Server authorization gate [WAVE 4, Tier 3] (depends U3)
- Extend `Authorize`/dispatch to enforce host-only methods by trusted UserID; listeners keep
  add + remove-own. Reject with `ErrorPermissionDenied`. Tests: listener blocked from
  skip/reorder/remove-other/transport; host allowed.

### U5 - Web role gating [WAVE 5, Tier 2] (depends U4)
- Hide/disable host-only controls for listeners (QueuePanel play/move/remove, TransportUI
  play-pause/seek); role badge in presence. Server stays authoritative (UI is convenience only).

### U6 - Docs + protocol [WAVE 6, Tier 1] (depends U1-U5)
- `docs/protocol.md` role table + per-method requirements; RFC doc; plan reconciliation; enablement
  note (`ROOM_AUTH_SECRET`, both flags).

## Dependency graph / waves

```
U1 (identity) ─┬─> U2 (web auth client)
               └─> U3 (host+role model) ─> U4 (authz gate) ─> U5 (web gating) ─> U6 (docs)
```

**This pipeline is intentionally narrow-and-sequential, not wide-parallel.** Auth layers build on
each other (identity -> host model -> gate -> UI); parallelizing dependent security code invites
integration bugs. Per the parallel-execution mandate's "genuinely dependent steps" exemption, each
wave here is one unit. **Wave 1 = U1** (the identity foundation) alone.

## Out of scope (do not resurrect silently)

- **Accounts / passwords / OAuth / cross-device identity.** Anonymous signed id is the bar.
- **DJ / co-host tier.** Binary HOST/LISTENER in v1; add a tier later only on demand.
- **Moderation (kick/ban), room passwords, private rooms.** Separate RFC if wanted.
- **Rewriting the membership gate.** It stays; roles layer on top of it.

## Legal / platform notes

- No change to the per-user-stream + metadata-sync model. This is purely in-room control, not
  playback or catalog behavior.
