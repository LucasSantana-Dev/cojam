# 165: Server owns member identity

Issue: #165 (https://github.com/LucasSantana-Dev/cojam/issues/165)
Parent: #141
Status: spec, ready for implementation
Date: 2026-08-01
Scope note: internal design doc, committed alongside docs/rfc/ and docs/adr/ (precedent: PR #146).

## 1. Goal and non-goals

Goal: close two identity holes. Presence stops being deduped by display name, so two guests
who pick the same name are two members and not one. And `addedBy` stops being free-text
client input, so a client can no longer attribute a track to someone else.

Decision: keep `AddedBy` a display name. Stamp it server-side instead of accepting it.

This is the correction to the obvious-looking alternative, which is to put the identity key
itself into `AddedBy`. Reject that:

- `apps/server/internal/hub/hub.go:862-866` records the existing split as a deliberate
  RFC-0005 (B16) decision: "AddedBy stays a client display name (capped by the validator);
  identity-grade attribution is server-owned via addedByUserId". Overwriting `AddedBy` with
  an identity key contradicts a recorded decision without cause.
- Every already-persisted track carries a display name in `AddedBy`
  (`apps/server/internal/queue/queue.go:52`). Redefining the field's meaning makes all of
  them unreadable and forces the UI into a placeholder fallback for historical rows.
- `packages/shared/src/protocol.ts:15` types `addedBy: string` as a display name and
  `:23` types `addedByUserId?: string` as the identity. The chat spec at `:75` reuses the
  same posture. Changing one of the pair breaks the symmetry the protocol already documents.

The defect is not that `AddedBy` holds a name. The defect is that the *client* chooses it.
The server already knows the connection's display name; it should use that.

Non-goals:

- No change to `AddedByUserID`. It is already server-stamped at hub.go:871 and correct.
- No display-name suffixing. That is #170.
- No platform plumbing. That is #171.
- No profile-backed name resolution. The join-supplied name stays the source of the display
  name; this spec only stops other clients from claiming it.

## 2. Identity key

Reuse `rateLimitKey` (`apps/server/internal/hub/hub.go:1470`), which already produces
`user:<userID>` for an authenticated connection and `client:<clientID>` for an anonymous
one. It is computed at `hub.go:1462` and threaded through `handleRPC` (hub.go:737) and
`dispatch` (hub.go:819) as `rlKey`, so every RPC case can already reach it.

No new plumbing is needed. This is the same key `queue.vote` already uses as its voter key,
so identity is consistent across features by construction rather than by convention.

## 3. Presence carries identity

The connection info assembled at `apps/server/cmd/server/main.go:333-341` currently forwards
only `name`. Add the identity key:

```json
{ "id": "user:sb-1234", "name": "Alice" }
```

Web side, the `Member` type gains `id` alongside the existing `clientId`. `clientId` stays
the centrifuge connection id used as a React key; `id` is the identity used for dedupe.

Backward compatibility: if `id` is absent (an older server, or a cached presence entry),
the client synthesizes `client:<clientId>`. That is exactly what the server would have sent
for an anonymous connection, so the fallback is correct rather than merely safe.

## 4. Presence dedupe moves off name

`apps/web/app/room/components/PresenceBar.tsx:13-21` currently dedupes by display name, and
the fused chip at `apps/web/app/room/[id]/client.tsx:141-146` does the same. Both key on
`id` instead.

Consequence, and it is the point of the slice: two guests both named "Alice" now render as
two entries and the listener count reads 2. Both entries currently read "Alice", which is
correct but ambiguous. Disambiguating them is #170, which is why #170 is blocked on this and
not merged into it.

## 5. Server stamps addedBy

The hub needs the display name per connection. It already tracks authenticated identity per
connection in `clientUserID` (hub.go:252, written at hub.go:409-412, cleaned at
hub.go:418-420). Add a parallel `clientName map[string]string` under the same mutex, written
and cleaned at the same two points, so the two maps cannot drift.

In the `queue.add` case (hub.go:851-878), after `validateImportTracks` and next to the
existing `req.Track.AddedByUserID = userID` line at hub.go:871:

```go
// Server-owned identity: never trust a client-supplied addedByUserId.
req.Track.AddedByUserID = userID
// Server-owned attribution: the display name comes from this connection's
// presence identity, not from the request body.
req.Track.AddedBy = h.displayNameFor(clientID)
```

`validateImportTracks` (hub.go:38-73) keeps its length cap on `AddedBy`. The cap now only
ever sees server-supplied values, but leaving it in place costs nothing and keeps the
validator honest about the shape of a `TrackRef` regardless of its origin.

`playlist.import` takes the same treatment: it crosses the same trust boundary (RFC-0007)
and every imported track must carry the importer's server-known name.

## 6. Edge cases and failure modes

- Track persisted before this change: `AddedBy` still holds whatever name the client sent.
  It renders unchanged. No migration, no placeholder. This is the payoff for not redefining
  the field.
- Connection with no recorded name (rejoin race where the RPC lands before the name is
  recorded): fall back to the existing default `"Listener"` rather than an empty string, so
  attribution is never blank.
- Two guests with the same name: both tracks now show the same `AddedBy` string, and both
  are truthful. #170 makes them visually distinct.
- Anonymous connection: identity key is `client:<clientID>`, which changes on reconnect.
  Attribution on already-queued tracks is unaffected, since `AddedBy` was stamped at add
  time and is not recomputed.
- `FEATURE_ROOM_AUTH` off: every connection is anonymous, every key is `client:<clientID>`,
  and both the dedupe and the stamping work unchanged.
- A client that keeps sending `addedBy`: silently ignored. No error, since a rejection would
  break older clients for no security gain once the value is discarded.

## 7. Acceptance criteria (mapped to verify commands)

Server (`cd apps/server && go test -race ./...`, `go vet ./...`):

- New `apps/server/internal/hub/hub_identity_test.go`:
  - `queue.add` with a spoofed `addedBy` naming another member stores the caller's
    server-known display name, not the spoofed value. This is the regression test for the
    trust boundary and must fail if the stamping line is removed.
  - `playlist.import` stamps every imported track the same way.
  - A connection with no recorded name stamps `"Listener"` rather than an empty string.
  - `AddedByUserID` behavior at hub.go:871 is unchanged.
  - `clientName` is cleaned on disconnect alongside `clientUserID`, verified by asserting
    the map is empty after the existing cleanup path runs.
- Connection info assembled at main.go:333-341 includes `id` and `name`, with `id` equal to
  `rateLimitKey` for both an authenticated and an anonymous connection.
- Race detector clean under `-race` with concurrent connect, add, and disconnect.
- `go vet ./...` clean.

Web (`cd apps/web && npx tsc --noEmit`, `pnpm lint`, `npx vitest run`):

- `Member` gains `id`; the shared type compiles workspace-wide.
- Conn-info parsing extracts `id`, and synthesizes `client:<clientId>` when it is absent.
- PresenceBar renders two entries for two members sharing a display name, and the listener
  count reads 2. This is the test that fails today.
- The fused chip at client.tsx:141-146 dedupes on `id`, asserted by the same two-same-name
  fixture.
- Existing queue rendering is untouched: a track whose `addedBy` is a plain display name
  still renders that name.

E2E (`pnpm --filter web e2e` only, never raw playwright on :3000):

- Two browsers join one room with the identical display name. Presence shows two members
  and a count of 2. Each queues a track, and each track is attributed to that name.
