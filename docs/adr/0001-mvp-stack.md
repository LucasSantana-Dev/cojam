# ADR-0001: MVP stack — Next.js + Go/centrifuge + Postgres

**Date:** 2026-07-16 (amended same day: backend flipped NestJS → Go + centrifuge)
**Status:** accepted
**Decided via:** /research-and-decide (research agent + critic agent + CV-weight research agent + Go-variant critic + dual portfolio inventory local/GitHub + operator decision)

## Context

Greenfield MVP (plan: `.claude/plans/music-jam-mvp-2026-07-16.md`): realtime group-listening rooms, metadata-only sync, browser loads Apple MusicKit JS + YouTube IFrame SDK (client-side, DRM/EME, user-gesture gated), Spotify Web Playback SDK later. Solo part-time dev. Architecture pre-fixed by earlier debate: Node server, socket.io v4 rooms, Redis room state.

Operator added two explicit decision criteria mid-process:
1. **CV/hiring weight** — not just ship speed. This flips several layers away from the pure reuse-what's-here answer.
2. **Tool gap** — prefer tools the operator has NOT yet shipped in any existing project (local repos + GitHub), so this project expands the portfolio instead of repeating it. A candidate already used in production elsewhere loses gap points even if it ranks high on hiring demand; a candidate that is both in-demand AND absent from the portfolio ranks highest.

## Decision

- **App shell:** Next.js 16 (App Router, TypeScript). Player SDKs live in client components loaded with `next/script`; realtime UI is client-side. zustand for room/client state, Tailwind 4. Realtime client: `centrifuge-js`.
- **Backend service:** **Go** — chi router + **centrifuge** (embeddable Go realtime library: channels/rooms, reconnect with recovery, presence, backpressure) + golang-jwt (Apple ES256 developer token; Spotify OAuth later). Matching API (ISRC → MusicBrainz → fuzzy YouTube) in the same service.
- **Persistence:** Postgres via pgx + sqlc (match cache, room + queue durability, metrics). **No Redis day-1**: centrifuge Memory engine on a single node; queue mutations write through to Postgres synchronously (low write rate) so a restart recovers room queues; presence is ephemeral by design. Redis engine is the documented multi-node upgrade path.
- **Monorepo:** pnpm workspaces for TS (`apps/web`, `packages/shared` protocol types); `apps/server` is a Go module in the same repo.
- **Testing:** Go `testing` + `-race` for the hub/server, Vitest (web unit), Playwright (e2e, two-browser room scenarios).
- **Deploy:** Fly.io via Docker (server + web), managed Postgres (Fly Postgres or Neon).

The Go flip trades the critic's 8-9 week NestJS path for an honest ~10-11 weeks (centrifuge removes the hand-rolled protocol weeks from the 10-13 full-DIY estimate). Operator explicitly accepted the tradeoff for CV + tool-gap value; ship-speed ceased to be the binding criterion.

## Alternatives considered

Each alternative is scored on three criteria: ship speed (critic), CV/hiring weight (research), and tool gap (does it add a tool absent from the operator's portfolio — scores below marked "gap: pending" until the inventory lands; amendment will finalize).

- **NestJS + socket.io + Prisma (first accepted version of this ADR; Go-variant critic's winner):** ships 8-9 weeks, enterprise TS hiring signal, fills NestJS+socket.io gaps. Overruled by operator: Go fills a bigger gap (zero Go in local disk AND public GitHub; no toolchain even installed) with higher hiring signal (+41% job growth, top-5 demand), and the timeline criterion was declared soft. Kept as fallback if Go friction stalls product work ≥2 weeks.
- **Express 5 + Prisma + npm (pure habit stack, first critic's winner pre-CV-criterion):** fastest to ship (~0 ramp), rejected because it adds no CV signal and fills zero tool gaps (all three already shipped in Lucky).
- **Fastify v5 + Drizzle + better-sqlite3 + Railway (benchmark-optimal):** rejected; critic flagged claims as noise at ≤100 rooms scale (HTTP layer thin; bundle size irrelevant server-side; Railway + Redis add-on ≥ Fly cost). Fastify carries little hiring signal vs NestJS. Gap: pending (likely fills a gap, but gap alone doesn't outrank NestJS's hiring signal).
- **Go hand-rolled hub (chi + coder/websocket + own room registry):** maximum learning value but critic-estimated 10-13 weeks with race-condition/goroutine-leak debugging for a Go newcomer; ~800 lines of untested protocol code reimplementing reconnect/rooms/backpressure. Softened to the chosen variant: centrifuge supplies exactly that layer while the app code is still Go.
- **Elixir Phoenix:** realtime prestige, fills a gap, junior-hostile market, learning language+OTP+LiveView in 6 weeks = MVP suicide; rejected.
- **Cloudflare Workers + Durable Objects:** zero recruiter signal, non-trivial mental model; rejected despite filling a gap (kept as >500-rooms scaling escape hatch per earlier debate).
- **SQLite:** technically sufficient; rejected on CV grounds (reads hobby-grade). Gap: pending — if Postgres turns out absent from the portfolio, it doubles as a gap fill; if present, it's still the CV pick.
- **Bun/Hono:** trend noise solo; rejected even as gap fill (gap value requires hiring demand to convert).

Chosen-stack gap status (finalized from dual inventory, 2026-07-16): **Go: fills** (absent from all local repos + public GitHub, toolchain wasn't installed); **centrifuge/socket.io-class realtime: fills** (only raw `ws` shipped before); **Fly.io: fills** (Vercel/Cloudflare/Docker/SST shipped, Fly never); **sqlc/pgx: fills** (Prisma/Drizzle shipped); **pnpm: non-gap** (6 local projects) but keeps monorepo consistency; **Next.js: non-gap locally** (Craftvaria, Criativaria) yet absent from public GitHub, so a public music-jam still adds visible evidence; **Postgres: non-gap** (kept on CV grounds). Non-gaps carried for convergence: React 19, zustand, Tailwind 4, Vitest, Playwright.

## Consequences

- Positive: stack line reads "Next.js 16 App Router + Go realtime server (centrifuge) + Postgres on Fly.io" — Go realtime is a senior-signal interview story ("goroutine room hub with recovery-on-reconnect"), fills the portfolio's biggest visible gap, and stays cheap (single container + Postgres).
- Negative: honest MVP estimate 10-11 weeks (Go ramp + sqlc learning); centrifuge is a smaller community than socket.io; TS/Go type duplication for the room protocol (mitigated by a single JSON protocol doc + thin types on each side).
- Neutral: Vite dropped (Next bundles); Vitest stays for web; no Redis until multi-node.

## Revisit when

- Go friction stalls product work ≥2 weeks (not learning-adjacent, but blocked) → fall back to NestJS + socket.io variant recorded above; protocol doc keeps the client portable.
- Rooms >1 node needed → switch centrifuge Memory engine → Redis engine (documented path, config-level).
- Rooms >500 concurrent or multi-region latency complaints → re-open Durable Objects/PartyKit for the WS layer.
- Queue-loss-on-restart complaints despite Postgres write-through → re-evaluate Redis day-1.
- Job-market signal shifts (re-check yearly; hiring data rots).
