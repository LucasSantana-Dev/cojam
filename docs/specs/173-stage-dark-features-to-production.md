# 173: Stage public rooms, queue voting, room chat onto production

Issue: #173 (https://github.com/LucasSantana-Dev/cojam/issues/173)
Blocked by: #168, #165, #170
Status: spec, ready for execution once blockers land
Date: 2026-08-01
Scope note: internal design doc, committed alongside docs/rfc/ and docs/adr/ (precedent: PR #146).

## 1. Goal and non-goals

Goal: take three code-complete, tested, dark features live on
`cojam.lucassantana.tech`, one flag at a time, with a verification window and an explicit
go or no-go between each.

This is HITL and operator-only. It touches live production. Nothing in this spec should be
executed by an agent.

Non-goals:

- No code changes. The features shipped 2026-07-23.
- No infrastructure changes. RFC-0006 runtime flags are already deployed.
- No batching. Each flag is enabled and verified alone.
- No automatic rollback. Rollback is an operator decision with an operator-run command.

## 2. Prerequisites

Two gates, both hard.

**Runbook gate.** #168 must have landed, so the per-flag procedure, verification signals,
and rollback commands exist in `docs/runbooks/feature-rollout-plan.md`. This spec is the
execution plan; the runbook is the reference it executes against. Running this without the
runbook means improvising rollback under pressure.

**Identity gate.** #165 and #170 must be merged AND deployed before queue voting or room
chat are enabled. Merged is not sufficient; the running server and web images must contain
them. Both features key off display identity, and enabling them earlier puts name-based
impersonation into live features.

Public rooms is not behind the identity gate and can go first.

## 3. Preflight

Follow the go or no-go checks already in section 3 of the rollout runbook. Do not restate
them here; a duplicated checklist is a checklist that will drift.

Go only if all three cojam containers are healthy, `/readyz` reports ready, the public URL
returns 200 through the tunnel, and `/env.js` shows the expected starting flag set.

Record the starting flag set before the first flip. It is the rollback target.

## 4. Backup

Snapshot the database before the first flip.

Confirm the actual database name, user, and container name from the compose configuration
before running any dump command. Do not copy connection parameters from a spec or a memory
note; a dump that silently targets the wrong database produces a backup that is worthless at
exactly the moment it is needed.

Record the snapshot path and timestamp in the execution log.

Note that these three flags do not perform data migrations. The snapshot is insurance
against the unexpected, not a step the rollback procedure depends on. Flag rollback is
env-plus-recreate and takes seconds.

## 5. Order

1. Public rooms. Independent, LOW risk, no identity dependency.
2. Pause at the identity gate. If #165 and #170 are not deployed, stop here. Stopping is a
   valid and expected outcome of this runbook, not a failure.
3. Queue voting.
4. Room chat.

Voting and chat are independent of each other, so their relative order is free. Both depend
on identity. Do not enable them in the same window even though they share a prerequisite:
if something breaks, one flag flipped means one suspect.

## 6. Per-flag cycle

For each flag, in order, following the runbook's procedure:

**Enable.** Set both variables for the flag in the host `.env` — the server flag
(`FEATURE_PUBLIC_ROOMS`, `FEATURE_QUEUE_VOTING`, or `FEATURE_ROOM_CHAT`, gated at
`apps/server/cmd/server/main.go:106-109`) and its web counterpart (`COJAM_FEATURE_*`, per
`apps/web/lib/features.ts`) — and recreate both the server and the web container. One flag
only. Setting only the web flag is the worst available state: `/env.js` reports the feature
enabled and the UI renders it, while the server still rejects its RPCs with
`centrifuge.ErrorMethodNotFound`.

**0 to 2 min.** Both containers healthy and not restarting, public URL still 200, `/env.js`
shows the intended flag, and the server startup log shows the feature enabled. This proves
both layers of the flip, not the feature.

**2 to 5 min.** Open the product and observe the feature's own behavioral signal from the
runbook. Check the browser console for React hydration warnings, per the RFC-0006
contingency; a hydration warning after a flip means a render site was not migrated to the
runtime hook and is grounds for immediate rollback.

**5 to 15 min.** Exercise the feature across two browsers, since a single browser proves
only local rendering. Check server logs for the feature's RPCs succeeding and for the
absence of an error spike.

**15+ min.** Confirm stability across a reconnect and confirm the container has not
restarted since the flip.

**Go or no-go.** Record the outcome and the time before touching the next flag. If any
window fails, roll back that flag and stop the sequence. Do not continue to the next feature
with a known-bad flag live.

## 7. Feature-specific verification

The signals live in the runbook per #168. The three that are easy to get wrong:

- **Public rooms** is verified by a room appearing in the landing strip from a *different*
  browser than the one that made it public. The strip has a static placeholder, so a casual
  glance at the landing page can look like success while the feature is dead.
- **Queue voting** is verified by a count changing in browser B when browser A votes. A vote
  that only increments locally is the exact failure the identity gate exists to prevent.
- **Room chat** is verified by sender attribution being correct in the receiving browser,
  not merely by a message arriving. Wrong or empty attribution is the identity failure
  surfacing.

Chat history is ephemeral by design. An empty history after a server restart is correct and
must not trigger a rollback.

## 8. Rollback

Trigger on any of: hydration or render breakage, connections rejected, the feature's RPCs
erroring, cross-browser sync failing, or wrong identity attribution.

The command is the runbook's per-flag rollback: remove both variables (server and web) and
recreate both containers. Recovery is seconds. Verify `/env.js` has returned to the
pre-flip flag set recorded in section 3 and that the server startup log no longer shows
the feature enabled; a rollback that reverts only the web flag leaves the server half of
the feature live with no UI to reach it.

Roll back one flag, the most recent one. Do not clear every flag in response to one failure;
that discards verified progress and obscures which change caused the problem.

Restoring the database snapshot is not part of flag rollback and should not be done reflexively.
These flags do not migrate data.

## 9. After

- Record per flag: enable time, verification outcome, any rollback and its cause.
- Update the project memory note for the rollout, replacing the "dark in production" status
  with what is now live.
- Skim server logs once more for accumulated errors.
- Confirm the flags survive a deliberate restart of both containers, which is the check
  that proves the variables were persisted to `.env` and not just injected into running
  containers.
- Keep the database snapshot for a week.

## 10. Decisions for the operator

Flagged rather than assumed:

- The maintenance window. The runbook says any low-traffic period and not Friday night. The
  specific slot is the operator's call.
- Whether to enable voting and chat in one session or on separate days. The spec requires
  separate windows, not separate sessions.
- Whether to announce to the friend group before flipping. The runbook calls a heads-up
  sufficient at this scale.
- Whether to proceed at all if the identity gate is unmet. The default is to stop.

## 11. Acceptance criteria

- Runbook gate satisfied: #168 landed.
- Identity gate satisfied and verified deployed, not merely merged, before voting or chat.
- Preflight passed and the starting flag set recorded.
- Database snapshot taken, with connection parameters confirmed against compose rather than
  copied.
- Public rooms enabled, all four windows verified, outcome and time recorded.
- Queue voting enabled in its own window, all four windows verified, outcome recorded.
- Room chat enabled in its own window, all four windows verified, outcome recorded.
- No two flags enabled in the same window.
- Hydration check performed after each flip.
- Cross-browser verification performed for voting and chat, not single-browser.
- Any rollback recorded with its trigger and root cause.
- Flags confirmed to survive a container restart.
- Post-rollout memory note updated.
