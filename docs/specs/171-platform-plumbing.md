# 171: Forward platform through presence, or delete the plumbing

Issue: #171 (https://github.com/LucasSantana-Dev/cojam/issues/171)
Parent: #141
Blocked by: #165
Status: spec, ready for implementation
Date: 2026-08-01
Scope note: internal design doc, committed alongside docs/rfc/ and docs/adr/ (precedent: PR #146).

## 1. Goal and non-goals

Goal: resolve a wired-but-dead path. The client sends `platform` in connection info at
`apps/web/lib/realtime.ts:127-128` and parses it back at `:77-82`, but the server forwards
only `name` at `apps/server/cmd/server/main.go:333-341`. The value is sent, never returned,
and the parse branch is unreachable in production.

Decision: forward it. Do not delete.

- The client half already exists and is already tested. Forwarding is one field added to a
  map that #165 is editing anyway, in the same function, in the same release.
- Deleting is not cheaper. It means removing the send, the parse branch, the `platform`
  field on `Member`, and the icon render at PresenceBar, and it forfeits a feature the UI
  was already built for.
- The asymmetry matters: shipping the field and removing it later is a small deletion, while
  deleting now and rebuilding later means re-deriving the whole path. Prefer the reversible
  direction.

The alternative is specified in section 5 rather than omitted, because the issue asked for
both paths priced and because the decision should be re-checkable if the icon proves to be
noise.

Non-goals:

- No platform auto-detection. The client declares what it is playing on.
- No routing, fallback, or matching behavior keyed on platform. It is presence metadata.
- No mid-session platform change. Connection info is set at connect time.

## 2. Server change

The connection info map at `apps/server/cmd/server/main.go:333-341` gains `platform`,
alongside the `id` field that #165 adds to the same map. The two changes touch the same
lines, which is the reason this slice is sequenced after #165 rather than in parallel.

Validate against the closed set `spotify`, `apple`, `youtube` and drop anything else. This
is not a security boundary, since presence metadata cannot escalate anything, but an
unvalidated passthrough would let a client publish arbitrary strings into every other
client's presence state, and the whitelist costs one comparison.

Omit the key entirely when the client sent nothing or sent an unrecognized value, rather
than emitting an empty string. The web parse at realtime.ts:77-82 already treats absent as
"no platform", so omission needs no client change while an empty string would need one.

## 3. Web change

None required. The send at realtime.ts:127-128, the parse at :77-82, the `platform` field on
`Member`, and the icon render in PresenceBar all already exist and are already exercised by
the existing tests. This slice makes the existing code reachable rather than adding to it.

The one thing to verify is that the icon renders from live presence rather than from
client-local state, since a component that reads its own platform from local state would
look correct in a single browser and be wrong for every other member.

## 4. Edge cases

- Client sends no platform: key omitted, no icon, no layout shift.
- Client sends an unrecognized value: dropped by the whitelist, renders as no platform.
- All members on one platform: identical icons, which is accurate.
- Platform changes mid-session (user switches service): connection info is fixed at connect,
  so the icon goes stale until reconnect. Accepted for v1 and worth stating, because a stale
  icon is a plausible bug report and this is the explanation.
- Guest connection: unaffected. Platform is independent of authentication.

## 5. The rejected alternative, priced

If the icon proves to be noise, deletion is: remove the `platform` key from the connection
info map, remove the send and the parse branch in realtime.ts, remove the field from
`Member`, and remove the icon render and its import from PresenceBar. Roughly five small
edits in two files, all mechanical, with no data migration because nothing about platform is
persisted.

That cost is what makes forwarding the safe choice now. If the reverse were true, and
removal were expensive, the honest recommendation would be to delete first and rebuild only
on demand.

## 6. Acceptance criteria (mapped to verify commands)

Server (`cd apps/server && go test -race ./...`, `go vet ./...`):

- Connection info includes `platform` when the client sends `spotify`, `apple`, or
  `youtube`.
- The key is omitted, not emptied, when the client sends nothing.
- The key is omitted when the client sends an unrecognized value, asserted with at least one
  arbitrary string so the whitelist is proven to reject rather than pass through.
- The `id` field from #165 is still present in the same payload, so the two changes to this
  map are proven not to have clobbered each other.
- `go vet ./...` clean.

Web (`cd apps/web && npx tsc --noEmit`, `pnpm lint`, `npx vitest run`):

- Conn-info parsing returns the platform when present and `undefined` when absent.
- PresenceBar renders the icon for a member whose platform came from presence, and renders
  no icon and no gap for a member without one.
- The icon is driven by the member's presence entry, not by local component state, asserted
  by rendering a member other than the local one.

E2E (`pnpm --filter web e2e` only, never raw playwright on :3000):

- Two browsers join one room declaring different platforms. Each sees the other's icon
  correctly, which is the assertion that would have failed before this change.
