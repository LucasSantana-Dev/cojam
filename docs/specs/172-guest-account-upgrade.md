# 172: Guest to account upgrade with attribution rebind

Issue: #172 (https://github.com/LucasSantana-Dev/cojam/issues/172)
Parent: #140
Blocked by: #165, #167
Status: spec, decisions resolved below, ready for implementation
Date: 2026-08-03
Revision 2026-08-03: post-critique amendments. Design critique verdict REVISE; decisions
A/B/C upheld with amendments folded in below (rebind trigger, collision message, token
burn, honest edge cases, identity-keyed state enumeration, rotation UX, client completion
rule, reference fixes).
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

Rebind trigger (amended): the client attempts a rebind on every room join while an
unconsumed proof token exists in localStorage, not only at sign-in time. A guest can sign
in outside any room and later join a room where their anonymous identity still owns state;
firing only at sign-in time misses that crash-recovery path. The client discards the stored
token only after confirmed success (the completion rule in section 5) or after the server
confirms the sub is dead (consumed or unverifiable). A transient failure leaves the token
in place for the next join.

## 3. Decision B: reject on collision

If the authenticated identity is already a member of this room on another connection, the
rebind fails with a user-facing message and changes nothing.

- The room holds one host. If the incoming authenticated identity is already present, and
  possibly already host, a rebind would have to merge or displace, and both are worse than
  refusing.
- The connection-to-identity map is `clientUserID` at `apps/server/internal/hub/hub.go:321`,
  `clientID -> userID`. Two connections claiming one userID in one room makes any reverse
  lookup ambiguous, which quietly breaks the host checks that depend on it.
- Merging two live sessions for one account is a genuinely larger feature. Refusing is the
  honest boundary, not a shortcut.

`IsUserIDInRoom` already exists at `hub.go:788` and answers exactly this question, so the
check is one call rather than new machinery.

Message (amended to cover the same-account-multi-tab case): "This account is already in
this room from another tab or device. Close it and retry."

## 4. Decision C: a dedicated RPC, and the server resolves the old identity itself

A new mutating RPC handles the rebind, rather than overloading `room.join`.

`room.join` already carries host assignment and reclaim logic at `hub.go:1300-1317`.
Teaching it to also detect an anonymous-to-authenticated transition would mean comparing a
previous identity it does not hold, on a path that runs for every join.

The important correction: **the client does not send its old identity.**

The obvious-looking design has the client pass its previous anonymous id, since it knows it
from localStorage. Reject that. #165, this slice's blocker, exists precisely to stop the
server trusting client-supplied identity. Accepting a client-declared "this used to be me"
would reintroduce the hole one slice after closing it, and it is a worse hole: a client
could name another guest's identity and claim their tracks and host role.

The equally obvious-looking fallback is that the server already knows the old identity from
connection state. Reject that too. Signing in means reconnecting with a Supabase token, and
a centrifuge connection's identity is fixed at connect time, so by the time the rebind RPC
arrives the old anonymous connection is gone. `rlKey` and `clientUserID` on the new
connection hold only the authenticated identity, and the captured `userID` in
`RegisterClient` cannot reach back to the previous connection.

The handoff state that survives the reconnect is the anonymous connection JWT itself.
`/api/connection-token` (`apps/server/cmd/server/connection_token.go:27`) mints a
server-signed token whose `sub` is the guest's durable anonymous userID, and the web
client already stores it (`apps/web/lib/auth.ts`). So the rebind RPC carries exactly one
field besides the room: that stored token. The server verifies it with
`connauth.ValidateForRefresh(secret, proof, refreshGrace)`, pinned here explicitly: the
same verifier and the same 30-day grace the token endpoint uses for identity continuity
(`connection_token.go:15`, `connection_token.go:40`), and it reads the old identity from
the verified `sub`. A token expired within grace must still upgrade; an acceptance test
covers it.

This is not a client-declared identity. The signature is server-issued, so a client can
prove only the anonymous identity it actually held; a token naming another guest's
identity fails verification exactly the way a forged refresh does. Holding the token *is*
the ownership proof, which is the same trust model the refresh path already ships.

Burn amendment (consumption): a successful rebind consumes the anonymous sub. The server
records consumed subs and rejects any later rebind that presents one, and
`/api/connection-token` rejects refresh for a consumed sub as well. Storage is the
implementer's call: a small `rebound_subs` table, or a documented in-memory set with
Postgres persistence; pick the simpler option that survives restart. The in-memory
fallback is dev/test-only: production deployments must run with `DATABASE_URL` so
the single-use guarantee survives restarts. Without the burn, a
retained or leaked token lets its holder claim whatever state a zombie anonymous
connection accumulates later, indefinitely. With it, the token is single-use end to end.
The burn supersedes the original repeat-call semantics: after a confirmed success the
client has already discarded the token, so a consumed-sub rejection is the dead-token
path, not a normal retry.

Guard: reject when the caller is not authenticated, since there is nothing to upgrade to,
and reject when the proof token is missing or fails verification, since there is nothing
to upgrade from, since an always-authenticated caller has no prior guest identity. Before
consumption, the first rebind to commit claims the state; after consumption, all reuse is
rejected. A pre-mutation check rejects already-consumed subs, and the atomic claim lands
immediately after the mutation commits (a claim inside the mutation could otherwise burn
the sub while the persisted room state never recorded the rebind). In-flight retries of
an unconfirmed rebind still present an unconsumed sub, so the client's
retry-while-unconfirmed loop is safe by construction.

## 5. Behavior

On an accepted rebind, within one mutation:

- Every track in the room whose owner is the caller's previous identity is reassigned to the
  authenticated identity.
- If the previous identity held the host role, the role moves.
- Votes: voter keys in `state.votes` rewrite from `user:<old>` to `user:<new>`. Under
  `FEATURE_ROOM_AUTH` guests vote as `user:<anonSub>` (see `rateLimitKey`, `hub.go:2058`);
  without the rewrite the upgraded member could double-vote as `user:sb:<uuid>`. Adjacent
  pre-existing bug, noted here and filed separately: `PruneGuestVotes` (`hub.go:591`)
  prunes `client:<id>` voter keys, which never match room-auth guests, so the #183 prune is
  a no-op under `FEATURE_ROOM_AUTH`.
- Seniority: transfer `memberJoinTimes[room][old]` to `[new]` (`hub.go:312`,
  `recordJoinTime` at `hub.go:502`) inside the same serialized mutation, before the
  versioned state publishes, so the upgraded member keeps longest-present standing
  for host promotion (#166) instead of restarting at the rebind instant.
- `RoomState.Version` bumps once and the state publishes, so both the upgrading client and
  every other member converge without a reload.

Membership gate: `room.rebind` is added to `mutatingMethods` (`hub.go:330`), so a caller
who is not a member of the room is rejected by the standard gate. A test asserts the
non-member rejection.

Zombie cleanup: on successful rebind the server force-disconnects the rebound sub's
remaining connections, reusing the `room.kick` disconnect mechanism. Section 6 explains
why this is load-bearing.

Idempotency: safety lives client-side now. The client retries while the outcome is
unconfirmed and discards the token on confirmed success; the server burns the sub at
commit and rejects reuse. A crash between commit and confirmation is covered by the
completion rule below.

`AddedBy`, the display name, is not rewritten. #165 stamped it at add time from the name the
member was using, and that remains a true record. Only the identity-grade ownership moves.

Client completion rule: the client keeps the proof token until it observes the post-rebind
`room.state` publication showing its authenticated identity, not merely the RPC 200. The
mutate path commits state before publishing and, per issue #178 (fixed by PR #231), does
not fail the RPC when the publish fails after commit; between commit and the client's
local save there is a window where the RPC succeeded but the client never saw the state.
Observing the publication closes that window. A crash before it leaves the token in
localStorage, and the next room join retries the rebind (section 2 trigger).

Secret-rotation UX: if proof verification fails because the room-auth secret rotated or
the token aged past the refresh grace, sign-in still proceeds and the user gets a soft
notice, "your earlier guest contributions couldn't be linked", not a hard error. The room
keeps working for the authenticated identity; only the attribution handoff is lost.

## 6. Edge cases and failure modes

- Rebind fails: the guest stays a guest with a working room. Every RPC still functions.
  Retry is safe once the conflict clears.
- Guest signs in on a second tab (corrected): decision B does not reject this. B checks
  the authenticated identity, and the second tab holds a different connection with the
  same account; the anonymous first tab is not the authenticated identity, so the rebind
  succeeds and would leave the first tab's anonymous connection live as a zombie that
  keeps accumulating attribution under the old sub. That is why section 5 has the server
  force-disconnect the rebound sub's remaining connections on success, reusing the
  `room.kick` mechanism.
- Guest host signs in (corrected): in a multi-member room the sign-in reconnect drops the
  anonymous connection first, `PromoteOnDisconnect` (`hub.go:686`) fires before any rebind
  can arrive, and the host role is already gone. Host recovery holds only when the guest
  is the sole member (no one to promote to) or when the web flow keeps the anonymous
  connection alive during sign-in. The recommended client path is popup OAuth: the room
  tab stays connected as the guest, the popup completes sign-in, and the rebind fires in
  place with the host role intact. Full-page redirect sign-in cannot preserve host in a
  multi-member room, and this spec does not pretend otherwise.
- Guest clears localStorage immediately after signing in: the anonymous keys and the proof
  token are gone, so a rebind attempted afterward fails the guard. With the amended
  trigger this is benign: the rebind fires on the next room join while the token is still
  present, and the client discards the token only on confirmed success or a confirmed dead
  sub.
- Rebind arrives while another member is mid-join: both run through the standard mutate path
  and serialize on the room lock. The joiner observes either the pre or post state, both of
  which are consistent.
- Accounts disabled at deploy: the RPC is unreachable and the UI entry point does not render,
  per #167.
- Stale comment to fix in this slice: `hub.go:691` says "guests cannot hold the host role
  (RFC-0005)", which is stale when `FEATURE_ROOM_AUTH` is on, since anonymous userIDs are
  non-empty and guests can hold the host role.

## 7. Acceptance criteria (mapped to verify commands)

Server (`cd apps/server && go test -race ./...`, `go vet ./...`):

- Unauthenticated caller is rejected.
- Missing or forged proof token is rejected: an always-authenticated caller has nothing to
  upgrade from, and a token that fails `connauth.ValidateForRefresh` proves nothing.
- Expired-within-grace token still upgrades: the proof verifies through
  `connauth.ValidateForRefresh(secret, proof, refreshGrace)` with the 30-day grace, and the
  rebind proceeds.
- Collision: the authenticated identity is already in the room on another connection, so the
  call is rejected and no state changes, asserted by an unchanged Version.
- Non-member caller is rejected by the `mutatingMethods` membership gate.
- Happy path across the reconnect: a guest queues two tracks, signs in (new connection
  carrying the authenticated identity, old anonymous connection gone), and rebinds by
  presenting the stored anonymous connection JWT. Both tracks are owned by the
  authenticated identity. Version bumps exactly once.
- Happy path: a guest host rebinds and the host role moves, verified by the authenticated
  identity passing a host-only check afterward.
- Votes: a guest vote recorded as `user:<anonSub>` is keyed `user:sb:<uuid>` after rebind,
  and the member cannot double-vote the same track.
- Seniority: `memberJoinTimes` transfers old to new, and the upgraded member wins
  longest-present promotion over a member who joined later.
- Zombie cleanup: after a successful rebind, remaining connections on the rebound sub are
  force-disconnected via the `room.kick` mechanism.
- Burn: a rebind presenting an already-consumed sub is rejected, and
  `/api/connection-token` refresh for a consumed sub is rejected.
- **The client cannot name someone else's identity.** The request carries no identity
  string, only the anonymous connection JWT, and a test asserts the handler derives the old
  identity solely from the signature-verified `sub`. This is the regression test for
  decision C and must fail if a client-supplied identity field is ever added.
- Rooms the guest has previously left are unaffected, per decision A.
- `AddedBy` display strings are unchanged by the rebind.
- Race detector clean under `-race` with concurrent join, add, and rebind.
- `go vet ./...` clean.

Web (`cd apps/web && npx tsc --noEmit`, `pnpm lint`, `npx vitest run`):

- The RPC wrapper sends the room and the stored anonymous connection token, carrying no raw
  identity field, asserted directly so the trust boundary is enforced on both sides.
- The rebind is attempted on every room join while an unconsumed proof token exists in
  localStorage, not only at sign-in time.
- The client keeps the proof token until it observes the post-rebind `room.state`
  publication showing its authenticated identity; RPC 200 alone does not discard it.
- A rotation or expiry verification failure leaves sign-in intact and surfaces the soft
  notice, not a hard error.
- Post-rebind state arrives through the normal room-state publication, so no local store
  surgery is required and none is added.
- The in-room entry point renders only for a guest with accounts enabled, matching #167.

E2E (`pnpm --filter web e2e` only, never raw playwright on :3000):

- BLOCKED, deferred to the popup-OAuth follow-up: a guest joins, queues a track, becomes
  host, signs in via the popup-OAuth path, and afterward still holds host and still owns
  the track. Popup-OAuth sign-in is not implemented in this slice (section 6 documents
  why full-page redirect sign-in cannot preserve host in a multi-member room), so this
  criterion cannot run until that flow exists.
