# 172: Guest to account upgrade with attribution rebind

Issue: #172 (https://github.com/LucasSantana-Dev/cojam/issues/172)
Parent: #140
Blocked by: #165, #167
Status: spec, decisions resolved below, ready for implementation
Date: 2026-08-01
Scope note: internal design doc, committed alongside docs/rfc/ and docs/adr/ (precedent: PR #146).

## 1. Goal and non-goals

Goal: a guest signs in from inside the room and keeps what they already did. Their host role
and their ownership of tracks they queued move from the anonymous identity to the
authenticated one.

Issue `#167` tells the guest their identity is browser-local. This slice is the escape hatch
that makes that message actionable rather than merely honest.

Non-goals:

- No account creation flow. Supabase already owns sign-in.
- No un-upgrade. Once authenticated there is no path back to the anonymous identity.
- No cross-room backfill. See decision A.

## 2. Decision A: scope is the current room only

Rebind touches the room the guest is in. Rooms they previously left are untouched.

- A left room has no live membership for this guest, so a rebind there changes nothing they
  can observe. The value is hypothetical, the cost is not.
- Backfilling every room means scanning all persisted rooms for the old key, or adding an
  index specifically to support it. That is real schema and query weight for an invisible
  benefit.
- Attribution left behind is not wrong. It records who queued a track at that time, under
  the identity they held then. That remains a true statement about the past.

If a returning-guest complaint ever materializes, a backfill can be added later against the
same rebind primitive. Nothing here forecloses it.

## 3. Decision B: reject on collision

If the authenticated identity is already a member of this room on another connection, the
rebind fails with a user-facing message and changes nothing.

- The room holds one host. If the incoming authenticated identity is already present, and
  possibly already host, a rebind would have to merge or displace, and both are worse than
  refusing.
- The connection-to-identity map at `apps/server/internal/hub/hub.go:252` is
  `clientID -> userID`. Two connections claiming one userID in one room makes any reverse
  lookup ambiguous, which quietly breaks the host checks that depend on it.
- Merging two live sessions for one account is a genuinely larger feature. Refusing is the
  honest boundary, not a shortcut.

`IsUserIDInRoom` already exists at `hub.go:424` and answers exactly this question, so the
check is one call rather than new machinery.

Message: "You are already in this room on another device. Sign out there first."

## 4. Decision C: a dedicated RPC, and the server resolves the old identity itself

A new mutating RPC handles the rebind, rather than overloading `room.join`.

`room.join` already carries host assignment and reclaim logic at `hub.go:840-843`. Teaching
it to also detect an anonymous-to-authenticated transition would mean comparing a previous
identity it does not hold, on a path that runs for every join.

The important correction: **the client does not send its old identity.**

The obvious-looking design has the client pass its previous anonymous id, since it knows it
from localStorage. Reject that. #165, this slice's blocker, exists precisely to stop the
server trusting client-supplied identity. Accepting a client-declared "this used to be me"
would reintroduce the hole one slice after closing it, and it is a worse hole: a client
could name another guest's identity and claim their tracks and host role.

The equally obvious-looking fallback is that the server already knows the old identity from
connection state. Reject that too. Signing in means reconnecting with a Supabase token — a
centrifuge connection's identity is fixed at connect time, so by the time the rebind RPC
arrives the old anonymous connection is gone. `rlKey` and `clientUserID` on the new
connection hold only the authenticated identity, and the captured `userID` in
`RegisterClient` cannot reach back to the previous connection.

The handoff state that survives the reconnect is the anonymous connection JWT itself.
`/api/connection-token` (`apps/server/cmd/server/connection_token.go:27`) mints a
server-signed token whose `sub` is the guest's durable anonymous userID, and the web
client already stores it (`apps/web/lib/auth.ts`). So the rebind RPC carries exactly one
field besides the room: that stored token. The server verifies it with
`connauth.ValidateForRefresh` — the same proof-of-ownership check the token endpoint uses
for identity continuity (connection_token.go:37-47) — and reads the old identity from the
verified `sub`.

This is not a client-declared identity. The signature is server-issued, so a client can
prove only the anonymous identity it actually held; a token naming another guest's
identity fails verification exactly the way a forged refresh does. Holding the token *is*
the ownership proof, which is the same trust model the refresh path already ships.

Guard: reject when the caller is not authenticated, since there is nothing to upgrade to,
and reject when the proof token is missing or fails verification, since there is nothing
to upgrade from — an always-authenticated caller has no prior guest identity. A repeat
call after a successful rebind is not an error: the proof still verifies but nothing in
the room is owned by the old identity, so the RPC reports success with zero changes, bumps
no Version, and publishes nothing. Retries are therefore safe by construction.

## 5. Behavior

On an accepted rebind, within one mutation:

- Every track in the room whose owner is the caller's previous identity is reassigned to the
  authenticated identity.
- If the previous identity held the host role, the role moves.
- `RoomState.Version` bumps once and the state publishes, so both the upgrading client and
  every other member converge without a reload.

Idempotent by construction. A repeat call finds nothing owned by the previous identity and
nothing to move, so it returns success with zero changes, bumps no version, and publishes
nothing — the same shape as any other retry, not a special case. A call under a *different*
authenticated identity is a real change and does publish, which is correct: it represents
an actual identity change and the room should see it.

`AddedBy`, the display name, is not rewritten. #165 stamped it at add time from the name the
member was using, and that remains a true record. Only the identity-grade ownership moves.

## 6. Edge cases and failure modes

- Rebind fails: the guest stays a guest with a working room. Every RPC still functions.
  Retry is safe once the conflict clears.
- Guest signs in on a second tab: the first tab still holds the anonymous identity in the
  room, so decision B rejects. The message names the fix.
- Guest host signs in: the host role moves to the durable identity, which is the strongest
  reason to want this feature. A closed tab can now be recovered by signing in again rather
  than depending on #166 promoting someone else.
- Guest clears localStorage immediately after signing in: the anonymous keys and the proof
  token are gone, so a rebind attempted afterward fails the guard. The rebind must fire at
  sign-in time, while the stored token is still present, and the client discards the
  anonymous token only after a successful rebind.
- Rebind arrives while another member is mid-join: both run through the standard mutate path
  and serialize on the room lock. The joiner observes either the pre or post state, both of
  which are consistent.
- Accounts disabled at deploy: the RPC is unreachable and the UI entry point does not render,
  per #167.

## 7. Acceptance criteria (mapped to verify commands)

Server (`cd apps/server && go test -race ./...`, `go vet ./...`):

- Unauthenticated caller is rejected.
- Missing or forged proof token is rejected: an always-authenticated caller has nothing to
  upgrade from, and a token that fails `connauth.ValidateForRefresh` proves nothing.
- Collision: the authenticated identity is already in the room on another connection, so the
  call is rejected and no state changes, asserted by an unchanged Version.
- Happy path across the reconnect: a guest queues two tracks, signs in (new connection
  carrying the authenticated identity, old anonymous connection gone), and rebinds by
  presenting the stored anonymous connection JWT. Both tracks are owned by the
  authenticated identity. Version bumps exactly once.
- Happy path: a guest host rebinds and the host role moves, verified by the authenticated
  identity passing a host-only check afterward.
- **The client cannot name someone else's identity.** The request carries no identity
  string, only the anonymous connection JWT, and a test asserts the handler derives the old
  identity solely from the signature-verified `sub`. This is the regression test for
  decision C and must fail if a client-supplied identity field is ever added.
- Idempotency: a second identical call returns success, changes nothing, and bumps no
  Version.
- A second call under a different authenticated identity holding the same proof does rebind
  and does bump, provided the old identity still owns state.
- Rooms the guest has previously left are unaffected, per decision A.
- `AddedBy` display strings are unchanged by the rebind.
- Race detector clean under `-race` with concurrent join, add, and rebind.
- `go vet ./...` clean.

Web (`cd apps/web && npx tsc --noEmit`, `pnpm lint`, `npx vitest run`):

- The RPC wrapper sends the room and the stored anonymous connection token, carrying no raw
  identity field, asserted directly so the trust boundary is enforced on both sides.
- Post-rebind state arrives through the normal room-state publication, so no local store
  surgery is required and none is added.
- The in-room entry point renders only for a guest with accounts enabled, matching #167.

E2E (`pnpm --filter web e2e` only, never raw playwright on :3000):

- A guest joins, queues a track, becomes host, signs in, and afterward still holds host and
  still owns the track.
