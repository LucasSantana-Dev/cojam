# 170: Disambiguate duplicate display names

Issue: #170 (https://github.com/LucasSantana-Dev/cojam/issues/170)
Parent: #141
Blocked by: #165
Status: spec, ready for implementation
Date: 2026-08-01
Scope note: internal design doc, committed alongside docs/rfc/ and docs/adr/ (precedent: PR #146).

## 1. Goal and non-goals

Goal: when two members share a display name, render them distinctly ("Alice", "Alice (2)")
in the PresenceBar and the fused chip, so the two entries #165 now produces are readable
rather than merely correct.

Decision: derive the suffix client-side from the identity-keyed member list. No server change.

- After #165 the client already holds everything required: each `Member` carries both `id`
  (identity) and `name` (display). Computing a suffix from that is a pure function of state
  the client already has, so a server round-trip would add a wire field and a Version bump
  to produce information the client can derive for free.
- A server-assigned suffix would also have to be recomputed and republished on every join
  and leave, turning a rendering concern into a source of `RoomState` churn.
- The suffix is presentation, and presentation belongs on the client.

Non-goals:

- No change to `AddedBy`. #165 keeps it a server-stamped display name, so queue attribution
  needs no key-to-name resolution and no placeholder for unknown members.
- No localization or configurable suffix format.
- No persistence of suffix assignments across sessions.

## 2. Assignment rule

Group members by `name`. Any group of one renders unchanged, with no suffix. For a group of
more than one, sort by `id` and assign in order: the first gets no suffix, the second
`" (2)"`, the third `" (3)"`.

Sorting by `id` makes the assignment **deterministic**, not stable. The contract is:

- For a fixed member list, every client computes the same labels without coordination, and
  a re-render cannot shuffle them. Identity keys do not change during a session, so the
  sort order is well-defined.
- Labels may change when membership changes. A new same-named member whose `id` sorts
  before existing members renumbers them; the newcomer does not necessarily get `" (3)"`.
  This is the price of a pure client-side function with no shared assignment state, and it
  is accepted: a rename here is a cosmetic relabel, not a correctness failure, and every
  client converges on the same new labels because the function is deterministic.

What membership changes do and do not disturb:

- A member joining with an unrelated name does not touch any existing suffix, since
  suffixes are computed per name group.
- A third "Alice" joining can renumber the existing Alices when its `id` sorts earlier.
  Both clients still agree on the result.
- A middle member leaving also renumbers those sorted after them. A room where a name
  collision partially resolves is rare enough that renumbering is acceptable, and the
  alternative (holding retired slots open) would leak state for the life of the session.

The rejected alternative is stable labels. Guaranteeing that a newcomer always gets the
next unused suffix requires a shared, ordered assignment — server-side allocation with
republish on every join and leave — which is exactly the `RoomState` churn section 1 rules
out for a presentation concern.

## 3. Web implementation

A pure helper computes a map from `id` to suffix from the member list, and a second helper
composes `name + suffix`. Both are pure functions with no store access, which is what makes
them directly testable without mounting a component.

The map is computed once where members are set in the store rather than in each consumer,
so PresenceBar and the fused chip cannot disagree about a member's label. Recompute on every
membership change, including the full resync that follows a reconnect.

Consumers:

- `apps/web/app/room/components/PresenceBar.tsx` renders the composed name. Its existing
  6-member display cap stays; the cap is a display concern and does not interact with
  suffixing, since suffixes are assigned over the full member list and not the visible slice.
- `apps/web/app/room/[id]/client.tsx:141-146`, the fused chip, uses the same composed name.

Queue attribution needs no change. #165 stamps `AddedBy` with the server-known display name
at add time, so a queued track already carries a readable name. Two tracks from two members
sharing a name will read identically, which is truthful: the queue records who queued a
track, not which of two same-named listeners is currently connected.

## 4. Edge cases

- All names unique: every suffix is empty and rendering is byte-identical to today.
- Three or more collisions: numbering continues, `" (2)"`, `" (3)"`, `" (4)"`.
- A member leaves and rejoins: an authenticated member keeps their `user:<userID>` key and
  therefore their sort position and suffix. An anonymous member gets a fresh
  `client:<clientID>` on reconnect and may sort differently, so their suffix can change.
  Acceptable, and inherent to anonymous identity being per-connection.
- A member with an empty name: falls back to `"Listener"` per the existing default, and then
  participates in collision grouping like any other name, since multiple defaulted members
  are exactly the case this feature exists for.
- Suffix collides with a literal name: a member who literally names themselves "Alice (2)"
  sits in its own group and renders unchanged. Two members could then both display
  "Alice (2)". Rare, cosmetic, and not worth escaping for.

## 5. Acceptance criteria (mapped to verify commands)

Web (`cd apps/web && npx tsc --noEmit`, `pnpm lint`, `npx vitest run`):

- Suffix helper unit tests:
  - Two members sharing a name produce `""` and `" (2)"`, assigned by sorted `id`.
  - Three sharing a name produce `""`, `" (2)"`, `" (3)"`.
  - Unique names produce `""`.
  - Repeated calls on the same input produce identical output (determinism).
  - Adding an unrelated member leaves existing suffixes untouched.
  - Adding a third same-named member whose `id` sorts earlier renumbers deterministically:
    the new labels follow the new sorted-`id` order, and every client computing from the
    same member list gets the same labels. Renumbering is asserted, not just tolerated.
- Compose helper returns `name` when the suffix is empty and `name + suffix` otherwise.
- PresenceBar renders "Alice" and "Alice (2)" for two same-named members, and reverts to a
  bare "Alice" after one leaves.
- The fused chip renders the same label as PresenceBar for the same member, asserted against
  one shared fixture so the two cannot drift.
- The name-based dedupe removed by #165 at PresenceBar.tsx:13-21 has no replacement
  reintroducing it.

E2E (`pnpm --filter web e2e` only, never raw playwright on :3000):

- Two browsers join one room with the identical display name. Presence shows "Alice" and
  "Alice (2)". One closes; the survivor renders as "Alice" with no suffix.
