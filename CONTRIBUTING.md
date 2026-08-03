# Contributing

Guide for human contributors. This file covers setup, verification, the
mistakes that have actually bitten us, and PR conventions.

A note on docs layout: ADRs (`docs/adr/`), runbooks (`docs/runbooks/`), and
failure post-mortems (`docs/failures/`) are kept local and gitignored by repo
convention (internal ops docs stay off the public repo). The links below point
at them for the maintainer's checkout; a fresh clone has only
[`docs/protocol.md`](docs/protocol.md) and `docs/specs/`.

## Dev setup

Prerequisites: Node.js 22 with pnpm, Go 1.26.

```bash
pnpm install
pnpm dev:server    # Go server on :8080
pnpm dev:web       # Next.js on :3000 (separate terminal)
```

Open `http://127.0.0.1:3000/room/vibe`, join with a name, add a track.

No credentials are needed for a working local setup: Deezer is the default
search/identity source and requires no API keys, so search, rooms, queue, and
YouTube playback all work out of the box. Every other provider is optional and
gates itself on env vars: with a provider's keys unset, matching is skipped
silently and rooms still work with manual track entry. See the Configuration
section in [README.md](README.md) for the full env list.

If you are testing Spotify login, browse the app at `http://127.0.0.1:3000`,
not `localhost` (see gotcha 3 below).

## Verify before opening a PR

Run all of these; they are the same gates CI runs.

```bash
(cd apps/server && go test -race ./... && go vet ./...)   # 1. server tests + vet
(cd apps/web && npx tsc --noEmit && pnpm lint)            # 2. web types + lint (ESLint 9 flat config)
(cd apps/web && npx vitest run)                           # 3. web unit tests
pnpm --filter web e2e                                     # 4. web e2e, from repo root (frees :3000 itself)
```

If you touched CSS, animations, or classnames, also run
`./scripts/check_web_drift.sh` from the repo root (it catches orphaned
`@keyframes` and off-palette colors, and runs in CI).

## Gotchas (learned the hard way)

These have all caused real, user-visible failures.

1. **E2E "0 tests" or a 120s timeout means port 3000 is busy, not that there
   are no tests.** Playwright starts its own web server on :3000 and refuses
   to reuse an existing one. A leftover `next dev` makes it hang. Always run
   `pnpm --filter web e2e`, which frees the port first. A "0 passed" e2e run
   is a config failure, never a green.
2. **Every mutation to `RoomState` must bump `Version`.** The web client only
   accepts a published state if its version is newer than what it has. Forget
   the bump and the change silently never appears until reload. If you add a
   mutating RPC, assert the version bump in a test.
3. **Spotify OAuth only works at `http://127.0.0.1:3000`.** Spotify rejects
   `localhost` redirect URIs. Browse the app at 127.0.0.1 when testing auth.
4. **Removing a feature means a repo-wide grep, not just deleting code.**
   Comments, log strings, doc rows, and UI labels survive a symbol deletion
   and point at ghosts. `grep -rniE "<term>"` should come back with only
   historical records (ADRs).
5. **Renaming CSS animations or classes needs a grep too.** Referencing a
   deleted `@keyframes` is not an error; elements just stay invisible while
   every check stays green. Run `./scripts/check_web_drift.sh` after any
   motion or CSS refactor.

## Server conventions worth knowing

- Outbound HTTP goes through `internal/httpx.Client`, never
  `http.DefaultClient`, and decodes are capped with `io.LimitReader`.
- New providers degrade gracefully: gate on env, return `ErrNotConfigured`
  when unset, wire behind a `FEATURE_*` flag.
- New RPCs: add a `case` in `hub.dispatch`; mutating methods also go in
  `mutatingMethods` and bump `RoomState.Version` (gotcha 2).
- Metrics are served at `/metrics` only on a dedicated listener when
  `METRICS_ADDR` is set, never on the public port.
- Playback is per-user streams synced by metadata only. The server never
  rebroadcasts audio.

## PR and CI conventions

- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`), PRs target
  `main`, small and reviewable beats sweeping.
- CI (`.github/workflows/ci.yml`) runs three jobs on every PR: Go server
  (build, vet, `go test -race`), Web (drift check, `tsc --noEmit`, lint,
  vitest, build), and Playwright e2e. All must be green.
- Docker images publish to GHCR on merge to `main`; deployment is manual via
  the runbooks (`docs/runbooks/launch-readiness.md`,
  `docs/runbooks/feature-rollout-plan.md`, local-only).

## Where things are documented

- Wire protocol (RPCs, room state, auth, runtime config):
  [docs/protocol.md](docs/protocol.md)
- Architecture decisions: `docs/adr/` (local-only)
- Post-mortems of real failures, with prevention rules: `docs/failures/`
  (local-only)
- Operations (launch gate, flag flips, backups): `docs/runbooks/`
  (local-only)
