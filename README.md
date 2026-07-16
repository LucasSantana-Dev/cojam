# Cojam

Cross-platform group music listening: friends on different streaming
services listen together in shared rooms.

![CI](https://github.com/LucasSantana-Dev/cojam/actions/workflows/ci.yml/badge.svg)

## What is it?

Cojam lets friends in the same room listen to music together, each using
their own streaming account (Spotify, Apple Music, or YouTube). A shared
queue syncs who plays what; the server coordinates metadata only, never
audio. Each listener plays on their own device through their native SDK,
maintaining DRM and respecting platform TOS.

**Features:**

- Create or join a room by ID
- Add tracks to a shared queue (via ISRC or title/artist search)
- Reorder, remove, or auto-advance tracks
- See who is listening in real time (presence)
- Cross-service track matching (ISRC first, then MusicBrainz fallback,
  fuzzy YouTube)

## Platform support

| Platform | Status | SDK | Notes |
| --- | --- | --- | --- |
| YouTube | Day 1 | IFrame embed | Public API, web only |
| Spotify | Phase 1 | Web Playback SDK | Premium user; Dev Mode capped at 5 |
| Apple Music | Deferred | MusicKit JS | $99/yr fee declined |
| YouTube Music | Not supported | None | No official API |
| Deezer | Not supported | None | API closed since 2024 |
| Tidal | Not supported | SDK | License agreement needed |

Metadata offset across services: 500ms baseline (physics, not a bug).

## Architecture & stack

**Frontend:** Next.js 16 (App Router) + React 19 + Tailwind CSS 4 + zustand +
centrifuge-js. Player SDKs (Apple MusicKit, Spotify Web Playback, YouTube
IFrame) loaded client-side via `next/script`.

**Backend:** Go server with chi router + centrifuge (realtime hub: rooms,
presence, reconnect recovery) + golang-jwt (Apple tokens). Track matching
via ISRC (YouTube API, Spotify Client Credentials).

**Persistence:** PostgreSQL (planned; in-memory rooms MVP). sqlc + pgx
type-safe. Queue mutations write-through to Postgres; presence ephemeral.

**Realtime model:** centrifuge channels (`room:<id>` per room). Clients
subscribe to authorize mutations; server authoritative for queue state.
RPC commands (`queue.add`, `queue.reorder`, `now_playing.advance`)
publish full `RoomState` on mutation.

**Monorepo:** pnpm workspaces. TypeScript (`apps/web`, `packages/shared`
protocol types); Go module (`apps/server`) colocated.

**Deploy:** Fly.io with Docker (Next.js + Go server + managed Postgres).

## Monorepo layout

```text
cojam/
├── apps/
│   ├── web/              # Next.js 16 frontend
│   │   ├── app/          # App Router pages
│   │   ├── lib/          # Features, auth, realtime, matching
│   │   ├── e2e/          # Playwright tests
│   │   └── package.json
│   └── server/           # Go server
│       ├── cmd/server/   # main.go, router, centrifuge
│       ├── internal/     # hub, match, appletoken, obs
│       └── go.mod
├── packages/
│   └── shared/           # TS types: TrackRef, RoomState
├── docs/
│   ├── adr/              # ADR-0001: MVP stack
│   ├── protocol.md       # Centrifuge protocol v0
│   └── design-references.md
├── .claude/
│   └── plans/            # Implementation plan
└── pnpm-workspace.yaml
```

## Getting started

### Prerequisites

- **Node.js 22** (for web) + **pnpm**
- **Go 1.26** (for server)
- **Docker** (optional: for containerized Postgres)

### Install

```bash
pnpm install
```

### Run locally

Start the server:

```bash
pnpm dev:server
```

Start the web frontend (separate terminal):

```bash
pnpm dev:web
```

Navigate to `http://localhost:3000`. Create a room (any ID) and add a
YouTube track. Open the room in another tab to test sync.

### Environment variables

#### Web (.env.local)

```bash
# Feature flags (defaults shown)
NEXT_PUBLIC_FEATURE_YOUTUBE=true
NEXT_PUBLIC_FEATURE_SPOTIFY=false
NEXT_PUBLIC_FEATURE_APPLE=false
NEXT_PUBLIC_FEATURE_PRESENCE=true

# Server connection
NEXT_PUBLIC_SERVER_WS_URL=ws://localhost:8080/connection/websocket
```

#### Server (.env or environment)

```bash
# Realtime & CORS
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000

# Feature toggles
FEATURE_MATCHING=true

# YouTube track matching
YOUTUBE_API_KEY=<key>

# Spotify track matching (client credentials)
SPOTIFY_CLIENT_ID=<id>
SPOTIFY_CLIENT_SECRET=<secret>

# Apple MusicKit developer token
APPLE_TEAM_ID=<team>
APPLE_KEY_ID=<id>
APPLE_PRIVATE_KEY_PATH=/path/to/key
```

**Note:** Every feature is flagged. All match providers are optional. Unset
API keys disable matching silently; rooms work with manual track entry.

### Running tests

**Server (unit + race detection):**

```bash
pnpm test:server
# or: cd apps/server && go test -race ./...
```

**Web (unit):**

```bash
pnpm --filter web exec vitest run
# or: cd apps/web && pnpm test
```

**Web (end-to-end):**

```bash
pnpm --filter web exec playwright test
# or: cd apps/web && pnpm e2e
```

## Status & roadmap

**Greenfield MVP (2026-07-16):** Day-1 YouTube only. Spotify Web Playback
in Phase 1. Apple MusicKit deferred (code stubbed; $99/yr fee declined).
Postgres durability in Phase 2.

**Current phase:** Per-room authorization + Spotify server matching
(Phase 3 S1).

**Observability:** Go server logs structured JSON to stdout + `/metrics`
(Prometheus). Web logs to browser console.

See `.claude/plans/music-jam-mvp-2026-07-16.md` for the implementation plan
and `docs/adr/` for architecture decisions.

**Build-in-public:** Development tracked in this repo; decisions documented
in ADRs.

## Why per-user streams?

Cojam uses the **Stationhead/Vertigo model**: each listener plays on their
own account/SDK; the server synchronizes queue metadata only, never audio.
This is legal and respects platform TOS.

The opposite model (rebroadcasting one audio stream to multiple listeners)
killed turntable.fm. It violates streaming agreements and TOS.

## License

MIT (placeholder; pending operator confirmation)

---

**Stack:** Go 1.26 + centrifuge + Next.js 16 + PostgreSQL.

**Testing:** `go test -race`, Vitest (unit), Playwright (e2e).

**Deploy:** Fly.io + Docker.
