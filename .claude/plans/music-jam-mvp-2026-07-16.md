# Plan: music-jam MVP — cross-platform group listening

**Date:** 2026-07-16
**Status:** active — stack decided (ADR-0001); Phase 0 tracer DONE 2026-07-16. **Phase 1 core DONE 2026-07-16** (renamed Cojam; public repo LucasSantana-Dev/cojam): shared queue add/remove/**reorder**, **auto-advance on track-end** (idempotent AdvanceAfter under multi-client races), presence (names+count), now-playing hero, YouTube playback, cached matcher + cache-hit metrics/logs. Go 36 + web 19 tests green; CI workflow gates PRs; postcss XSS patched; WS origin allowlist + queue cap added. **DEFERRED to Phase 2:** Postgres write-through (ephemeral rooms OK for MVP), per-room authorization + Spotify callback error genericization + e2e for advance/reorder (audit findings), presence platform badges. **Update 2026-07-18 (RFC-0004): Spotify playback activated (dark behind FEATURE_SPOTIFY) - matcher wiring decoupled from YouTube, Premium gate + YouTube degrade, presence platform badges shipped, unavailable-track state shipped. See docs/rfc/0004-spotify-playback-activation.md + docs/runbooks/spotify-enablement.md.** Prior status below.
**Prior status:** active — stack decided (ADR-0001); Phase 0 tracer DONE 2026-07-16 (Go/centrifuge rooms + YouTube playback + 2-browser e2e green; observability shipped). **Apple Music DEFERRED 2026-07-16: operator declines $99/yr Developer Program fee; token path + web player fully wired and tested (PKCS#8), reactivates by setting APPLE_* env vars once enrolled. Platform order now: YouTube day-1 + Spotify dev-mode next (free dev account, 5-user cap), Apple when fee justifiable.**
**Inputs:** /deep-research (5 parallel research agents) + /debate (5 lenses × 2 rounds + synthesis) + /research-and-decide (stack, ADR-0001 with CV-weight + tool-gap criteria)

## Goal

Friends on different streaming services listen to music together in shared rooms via a shared queue + presence ("Vertigo model"): each listener plays on their OWN account/SDK; the server syncs metadata only, never audio.

## Decisions (from debate synthesis)

1. **Platform scope day-1:** Apple Music (MusicKit JS) + YouTube (visible IFrame embed). Spotify added post-launch in dev-mode (5-user cap), then extended-access application backed by live metrics.
2. **Sync model:** queue/metadata sync only. No playhead drift correction at MVP (cross-service masters differ, ±500ms is physics; Spotify SDK drifts 0.5-1.5s anyway).
3. **Backend (superseded by ADR-0001, 2026-07-16):** ~~Node + socket.io + Redis~~ → **Go: chi + centrifuge + golang-jwt; Postgres via pgx/sqlc; no Redis until multi-node** (centrifuge Memory engine + Postgres write-through for queue durability). Flip driven by operator's CV-weight + tool-gap criteria (Go absent from entire portfolio). Durable Objects still the >500-rooms escape hatch. Frontend shell: Next.js 16 App Router (replaces Vite SPA), realtime client `centrifuge-js`.
4. **Track matching:** ISRC-first (Apple `filter[isrc]`), MusicBrainz fallback (1 req/s), fuzzy title/artist/duration for YouTube. Cache aggressively; Odesli optional and flaky (10 req/min) — treat as enhancement only.

## Scope

### In-Scope
- Room create/join, shared queue (add/remove/reorder), presence, "now playing" broadcast.
- Auth: Apple MusicKit user token, YouTube needs no user auth for embed playback.
- Track matching service with cache (server LRU + persisted lookups).
- Web client (single-page app), Node/socket.io backend, Redis room state.

### Out-of-Scope (with reasons — do not silently resurrect)
- **Deezer:** API closed to new app registrations (~2024). Revisit if it reopens.
- **YouTube Music:** no official API; ytmusicapi is TOS-violating. YT Music tracks resolve to plain YouTube videos via fuzzy match.
- **Tidal:** SDK Player exists but full-catalog license/approval uncertain. Post-MVP spike.
- **Tight playhead sync (any flavor):** deferred until demand proven.
- **Audio rebroadcast of any kind:** permanently prohibited (licensing; killed turntable.fm).
- **Native mobile apps:** web-first.

## Phases

### Phase 0: Tracer bullet (weeks 1-2 — Go ramp included)
**Objective:** prove Go/centrifuge room core + two-platform playback + matching skeleton before committing to full build.

**Steps:**
1. Scaffold monorepo: pnpm workspaces (`apps/web` Next.js 16 TS, `packages/shared` protocol types) + `apps/server` Go module (chi + centrifuge).
2. Room protocol v0 (single JSON doc, both sides implement): `queue.add`, `queue.remove`, `queue.state`, `now_playing.set`, presence join/leave.
3. Go server: centrifuge node (Memory engine), one channel per room, in-memory queue state, `go test -race` on queue reducer.
4. Next.js room page: `centrifuge-js` connection, shared queue UI, YouTube IFrame embed (visible) playing queue head; explicit "join & play" button (autoplay gesture gate).
5. Apple side: developer-token (ES256 JWT) issuing endpoint in Go (golang-jwt) + MusicKit JS auth + play one full track (requires Apple Developer Program membership; if unavailable, stub token endpoint and verify YouTube-only).
6. Matching walking skeleton in Go: ISRC → MusicBrainz lookup (keyless, 1 req/s limiter) → YouTube fuzzy search candidate (YouTube Data API key) with logged confidence.

**Files Touched:** `pnpm-workspace.yaml`, `package.json`, `apps/web/` (Next.js: `app/room/[id]/page.tsx`, `app/room/[id]/players/youtube.tsx`, `players/apple.tsx`, `lib/realtime.ts`), `packages/shared/src/protocol.ts`, `docs/protocol.md`, `apps/server/` (`go.mod`, `cmd/server/main.go`, `internal/hub/`, `internal/queue/`, `internal/match/`, `internal/appletoken/`), `.env.example`
**Verify:** `cd apps/server && go test -race ./...` ; `pnpm --filter web build` ; manual: two browser profiles join room, queue a track, both see synced queue and YouTube client plays it.
**Done When:** shared queue syncs between two browsers via centrifuge; YouTube client plays queue head; matching skeleton logs MusicBrainz/YouTube candidates; Apple playback proven OR explicitly deferred on membership.
**Time:** ~2 weeks (Go newcomer buffer).

**Replanning triggers:**
- Go/centrifuge friction blocks product work ≥2 weeks → ADR-0001 fallback: NestJS + socket.io (protocol doc keeps web client portable).
- MusicKit JS auth/DRM broken in target browsers (Safari quirks) → reassess platform order (Spotify dev-mode may move up).
- YouTube fuzzy match confidence unusable (>25% wrong) → add manual "pick the right video" UI to scope.

### Phase 1: MVP core (weeks 2-4)
**Objective:** real rooms, real auth, robust queue.

**Steps:**
1. Room lifecycle (create/join by link, host role, Redis-backed state, reconnect).
2. Queue CRUD + ordering + "now playing" advance (host-driven, gesture-safe auto-advance per client).
3. Matching service hardening: cache table, ISRC pipeline, per-quota rate limiting (MusicBrainz 1 req/s, Apple 10k/day), match-confidence flags surfaced in UI.
4. Presence: member list, per-member platform badge + playback state.
5. Platform adapter interface (`Player` capability flags) so Spotify slots in later without room-logic changes.

**Files Touched:** `apps/server/src/{rooms,queue,match,redis}.ts`, `apps/web/src/{room,queue,presence}/`, `apps/web/src/players/{types,apple,youtube}.ts`, `tests/`
**Verify:** `npm test` (queue + matching + room reducers); `npm run e2e` (Playwright: two clients, queue ops, reconnect).
**Done When:** 4+ concurrent users across ≥2 platforms in one room; queue survives host refresh; match cache hit-rate visible in logs.
**Time:** ~3 weeks.

**Replanning triggers:**
- socket.io room state outgrows single node earlier than expected → bring Durable Objects/PartyKit decision forward.

### Phase 2: Edge cases + launch prep (weeks 5-6)
**Objective:** survivable in friends' hands.

**Steps:**
1. Unavailable-track UX (track missing on member's platform → skip-for-me + badge).
2. Quota exhaustion + network-loss handling (cached results, optimistic queue, resync on reconnect).
3. Metrics/logging for later Spotify extended-access application (match success rate, rooms, engagement).
4. Deploy (single VPS or Fly.io/Render; Redis managed or same box), staging + prod.
5. Invite 4-6 friends; capture friction list.

**Files Touched:** `apps/server/src/metrics.ts`, `apps/web/src/ui/fallbacks/`, `deploy/` (Dockerfile, fly.toml or equivalent), `README.md`
**Verify:** `npm run e2e`; deployed URL smoke test; kill-server-mid-session reconnect test.
**Done When:** live URL, 2+ real sessions with ≥3 friends, no data-loss bug reported twice.
**Time:** ~2 weeks.

### Phase 3: Spotify + growth (week 7+)
**Objective:** add Spotify behind the adapter; start extended-access application.

**Steps:**
1. Spotify OAuth + Web Playback SDK adapter (Premium check, 5-user dev-mode allowlist).
2. ISRC matching extension (`external_ids.isrc`, `isrc:` search).
3. Apply for Spotify extended access with live product + metrics + documented per-user-stream model.
4. Tidal developer-platform spike (access process, Player module reality check).

**Files Touched:** `apps/web/src/players/spotify.ts`, `apps/server/src/auth/spotify.ts`, `apps/server/src/match.ts`
**Verify:** `npm run e2e -- --grep spotify`; mixed Apple+Spotify+YouTube room manual session.
**Done When:** mixed-platform room works with all three adapters; extended-access application submitted.

**Replanning triggers:**
- Spotify extended access denied → Spotify stays 5-user; product remains Apple+YouTube-led.
- Tidal access granted → schedule Tidal adapter phase.

## Dependencies & Assumptions

- Apple Developer Program membership ($99/yr) required for MusicKit developer token — needed before Phase 0 step 2.
- Assumes per-user-stream + metadata-sync model remains TOS-viable (precedent: Stationhead, Vertigo, JQBX/Turntable LIVE). Re-verify platform policies each phase; they rot fast (Spotify Feb 2026 cap).
- Solo dev; estimates assume part-time weeks.

## Notes

- Research + debate artifacts: knowledge-brain `music-jam-{overview,conventions,decisions}` memories; debate run wf_2c2dd862-c17.
- Key research facts baked into repo `CLAUDE.md` (platform constraint table).
- Stack decided in `docs/adr/0001-mvp-stack.md` (Next.js 16 + Go/centrifuge + Postgres/sqlc + pnpm + Fly.io); timeline widened to ~10-11 weeks total for Go ramp. Later-phase Files Touched entries referencing `apps/server/src/*.ts` are superseded by Go paths (`apps/server/internal/...`); update per phase as reached.
