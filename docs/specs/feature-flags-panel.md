# Feature flags panel: change flags without editing the environment

Issue: none (owner request, 2026-11-27: "uma interface pra definir essas flags sem precisar editar arquivos de texto")
Status: spec
Date: 2026-11-27

## Problem

Every flag is an environment variable read at boot. Turning one on in
production means editing the homelab `.env`, checking that `compose/cojam.yml`
passes it through, and recreating the containers. That is slow for a rollout
step (screen share on one test room), and too slow for a kill switch (screen
share off during an incident).

## Decision

Overrides live in Postgres and the environment stays the default.

- `feature_flags` (migration 0012) holds one row per overridden flag:
  `enabled` and, for screen share, `room_allowlist`. NULL means "follow the
  environment".
- `feature_flag_changes` is append-only: before, after, actor (`panel` or
  `cli`, never an address) and the operator's note. It is written in the same
  transaction as the row.
- The server applies overrides to the hub on the 15 s cycle it already runs
  for `room_restrictions`, at once after a panel write, and before the
  listener opens at boot (so a flag turned off in the database is never
  briefly on after a restart; if that first read fails three times the boot
  stops). A failed poll keeps the last state.
- The web app's `/env.js` reads `GET /api/features` (overridden flags only,
  booleans only) and merges it over its `COJAM_FEATURE_*` values, cached 5 s.
- One override drives both sides, so the server and web halves of a flag
  cannot drift apart through the panel.

### Which flags

Only flags the code checks on every call: `sync`, `queueVoting`, `roomChat`,
`publicRooms`, `video`, `screenShare` (+ allowlist). The hub gates became
atomics. Flags that wire routes, clients or secrets at boot (room auth,
Supabase auth, matching, radio, lyrics and the like) stay environment only:
flipping them at runtime would leave half-built state.

Screen share is the one gate with live state: turning it off, or narrowing
the allowlist, ends the affected shares at once with the usual trail, metric
and chat line (reason `disabled`). It still needs `FEATURE_ROOM_AUTH`; the API
refuses to turn it on otherwise and the resolver blocks a stale override.

### Access

`ADMIN_TOKEN` (32+ bytes) sent as a bearer token. One owner, and accounts are
optional in CoJam (the Supabase project is not always there), so a static
secret is the simplest lock that works in every deployment. Compared in
constant time over SHA-256 digests; every admin call goes through a per-IP
limiter (burst 20, one token every 3 s). Unset or short means the endpoints
answer 404; a production boot refuses a short one. The panel keeps the token
in `sessionStorage` only. The page is same-origin with the API (Caddy routes
`/api/*` to the server), so no CORS surface is added.

### Alternatives rejected

- **Edit `.env` from a UI.** Still needs a container recreate, and writing
  the host's secrets file from a web process is a worse risk than the problem.
- **Supabase user allowlist.** Ties the switchboard to an optional
  dependency that has been absent in production before.
- **Every flag runtime-editable.** Boot-wired flags would need a restart
  anyway, and pretending otherwise in the panel would mislead.

## Revisit when

- More than one person needs to operate flags (per-person identity in the
  trail instead of a shared token).
- Concurrent panel tabs: a PUT replaces the whole override with no version
  check, so the last write wins (both are in the trail).
- The server runs more than one instance: the immediate apply only reaches the
  instance that served the write; the others follow within one poll.
