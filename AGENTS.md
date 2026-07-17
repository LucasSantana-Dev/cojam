# AGENTS.md

Operational guide for coding agents (Claude Code, Copilot, etc.). Project
context, platform constraints, and the XP/TDD/observability agreements live in
[`CLAUDE.md`](CLAUDE.md); this file is the ops layer: how to build, verify, and
the failure modes that have actually bitten agents here.

## Layout

- `apps/server` — Go realtime server (chi + centrifuge). Separate Go module.
- `apps/web` — Next.js 16 App Router + Tailwind v4 + zustand. pnpm workspace member.
- `packages/shared` — TypeScript types shared with the web app (`@cojam/shared`), incl. the room protocol.
- Package manager: **pnpm** (pinned via the root `packageManager` field — do not remove it; CI's `pnpm/action-setup` reads it).

## Verify (run before declaring done — do not trust a subagent's claim, re-run yourself)

- Server: `cd apps/server && go test -race ./...`  ·  `go vet ./...`
- Web types/lint: `cd apps/web && npx tsc --noEmit`  ·  `npx next lint`
- Web unit: `cd apps/web && npx vitest run`
- Web e2e: `pnpm --filter web e2e` (this frees port 3000 first — see gotcha below). **Do NOT run raw `npx playwright test` while a dev server occupies :3000.**
- Full build: `pnpm --filter web build` (Next standalone output).

## Gotchas that have caused real failures (see `docs/failures/`)

1. **e2e "0 tests" / 120s webServer timeout = port 3000 not free**, NOT "no tests". `playwright.config.ts` starts its own web server with `reuseExistingServer: false` on :3000 so the feature-flag env applies; a stale `next dev` on :3000 makes it hang. Always run `pnpm --filter web e2e` (frees the port) or free :3000 first. A "0 passed" e2e result is a config failure, never a green.
2. **Every `RoomState` mutation published to clients MUST bump `RoomState.Version`.** The web store's `setState` accepts a publication only if `state.version > current.version`; a mutation that forgets `Version++` silently fails to update clients live (looks fine until reload). Assert the version bump in a test for any new mutating RPC.
3. **Spotify OAuth uses `http://127.0.0.1:3000`, not `localhost`.** Spotify (2025) rejects `localhost` redirect URIs; the registered URI is `http://127.0.0.1:3000/callback/spotify`. Browse the app at 127.0.0.1 for auth to work.

## Adding a music provider or server RPC (the established pattern)

- Outbound HTTP: use `internal/httpx.Client` (shared, timeout-configured) — never `http.DefaultClient`. Cap decodes with `io.LimitReader(resp.Body, httpx.MaxResponseBytes)`. Do not embed upstream error bodies in errors returned to clients.
- Keep the third-party base URLs in package-level vars so `*_test.go` can point them at `httptest` servers. Follow the `spotifyStub` pattern in `internal/match/match_test.go`.
- Gate optional providers on env and return `ErrNotConfigured` when unset (degrade gracefully, never crash). Wire behind a `FEATURE_*` flag in `cmd/server/main.go`. Deezer needs no credentials and is the default that works locally.
- New RPC method: add a `case` in `hub.dispatch`. If it mutates room state, add it to `mutatingMethods` (membership-gated) AND bump `Version` in the mutate closure. Reads return whatever JSON they need (not required to be `RoomState`).
- Playback is per-user streams synced by metadata only (Stationhead/Vertigo model) — never rebroadcast audio. Deezer/Tidal are search/identity sources, not players. See `CLAUDE.md` for the full platform constraints.

## Recording new failures

When a mistake is user-visible, high-risk, or likely to recur, add a note under
`docs/failures/` with a **Prevention/Detection** section naming the check or rule
that catches recurrence. Prefer making the rule enforceable (test/CI/script)
over prose.
