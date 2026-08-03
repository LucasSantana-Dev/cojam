# 168: Rollout runbook covers public rooms, queue voting, room chat

Issue: #168 (https://github.com/LucasSantana-Dev/cojam/issues/168)
Status: spec, ready for implementation
Date: 2026-08-01
Scope note: internal design doc, committed alongside docs/rfc/ and docs/adr/ (precedent: PR #146).

## 1. Goal and non-goals

Goal: extend `docs/runbooks/feature-rollout-plan.md` to cover the three features that
shipped on 2026-07-23 and that it does not mention: public rooms, queue voting, room chat.

The runbook today documents enrichment, sync, room-auth, and lastfm. Its per-flag notes
section stops before the newer features, so the three flags gating live user-facing code have
no documented enable procedure, no risk rating, and no rollback note.

Verified state as of 2026-08-01: live `https://cojam.lucassantana.tech/env.js` serves
`features: {"spotify":true,"roomAuth":true}`. The server defaults `FEATURE_SYNC`,
`FEATURE_QUEUE_VOTING`, `FEATURE_ROOM_CHAT`, and `FEATURE_PUBLIC_ROOMS` to false at
`apps/server/cmd/server/main.go:106-109`.

Dark-shipping is deliberate, not a defect. The runbook's own rollback section says sync
"ships dark for exactly this reason". The gap is coverage, not policy.

Non-goals:

- No code changes. Documentation only.
- No infrastructure changes. RFC-0006 already provides runtime flag passthrough.
- No executing the rollout. That is #173.

## 2. What to add

### 2.1 Per-flag entries

Extend the existing per-flag notes list in section 4 of the runbook, matching the style
already used for listenBrainz, sync, room-auth, and lastfmEnrich. Each new entry states the
server variable, the web variable, the risk level, the signal that proves the feature
actually works, and the rollback.

Confirm both variable names against `apps/web/lib/features.ts`, which maps each feature to
its `COJAM_FEATURE_*` runtime variable, and against `main.go:106-109` for the server side.
Do not copy the names from this spec without checking; the mapping is the source of truth and
this document is a summary of it.

**publicRooms.** Risk LOW. Independent of everything else in this backlog. Verification is
that the landing strip shows a real room rather than the static placeholder: create a room,
set it public, then load the landing page in a separate browser and confirm the room appears.
Confirming the flag is present in `/env.js` is a precondition, not the verification.

**queueVoting.** Risk MEDIUM, and gated on identity work. Verification is cross-client: two
browsers in one room, one votes, the other sees the count change. A single browser proves
only local rendering. Rate limiting is expected to reject a burst, so a rejection during a
deliberate burst test is a pass, not a failure.

**roomChat.** Risk MEDIUM, and gated on identity work. Verification is that a message sent
in one browser appears in another with the correct sender attribution, and that history
loads on rejoin. Chat is ephemeral by design, so an empty history after a server restart is
correct behavior and must be stated, or it will be mistaken for a bug during the rollout.

### 2.2 The ordering constraint

Record it as its own subsection, not as a footnote on the individual flags.

Public rooms may be enabled independently. Queue voting and room chat must not be enabled
until #165 and #170 are merged and deployed, because both features key off display identity.
Enabling them first would put name-based impersonation into live features rather than
leaving it confined to the queue, which is the whole reason #165 is sequenced ahead of the
rollout.

State the consequence, not only the rule. A reader who understands why the order exists will
not be tempted to reorder it under time pressure.

### 2.3 Verification windows

The runbook already uses 0-2 min, 2-5 min, 5-15 min, and 15+ min windows in section 5. Add
the three features to those windows rather than inventing a parallel structure.

The distinction to preserve throughout: `/env.js` showing the flag proves the flag flipped.
It does not prove the feature works. Every entry must name a behavior, observed in the
product, that fails if the feature is broken.

### 2.4 Contingencies

Add to the existing contingencies section:

- Voting counts do not sync between browsers: identity work is likely missing or not
  deployed. Roll the flag back and confirm #165 and #170 are live.
- Chat shows messages with wrong or empty sender attribution: same cause, same response.
  This is the specific symptom the ordering constraint exists to prevent.
- Landing strip is empty with the flag on: most likely no public room exists yet. Create one
  before concluding the feature is broken.

### 2.5 Consistency with the flag reference

`docs/runbooks/feature-flags.md` is the reference for what each flag gates. The rollout plan
is the procedure. Keep the split: do not duplicate the full flag table into the rollout plan.
Verify the three features appear in the reference table and add them if they do not.

## 3. Acceptance criteria

- `docs/runbooks/feature-rollout-plan.md` has a per-flag entry for public rooms, queue
  voting, and room chat, each naming both variables, a risk rating, a behavioral
  verification signal, and a rollback command.
- Variable names in the runbook match `apps/web/lib/features.ts` and
  `apps/server/cmd/server/main.go:106-109` exactly, checked rather than assumed.
- The ordering constraint is recorded as its own subsection, stating both the rule and the
  consequence of violating it.
- Every verification signal names an observable product behavior. No entry treats the flag
  appearing in `/env.js` as sufficient verification.
- Chat's ephemerality is stated explicitly so an empty history after restart is not read as
  a failure during rollout.
- The three contingencies in 2.4 are present.
- The three features appear in the `docs/runbooks/feature-flags.md` reference table.
- Existing sections 1 through 3 of the rollout plan are unchanged. This is an extension, not
  a rewrite.
- Cross-references to RFC-0006 and to the F1, F4, and F8 specs resolve.
