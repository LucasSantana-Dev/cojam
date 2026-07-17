# Cojam

Cross-platform group music listening app: friends on different streaming services (Spotify, Apple Music, YouTube; Deezer/YT Music constrained, see below) listen together in shared rooms.

## Status

Greenfield (2026-07-16). No code yet. Plan: `.claude/plans/` (see latest). Research + debate findings captured in the knowledge brain under tag `project/music-jam`.

## Hard platform constraints (researched 2026-07-16, verify before relying)

- Legal model is **per-user streams synchronized by metadata** (Stationhead/Vertigo model). NEVER rebroadcast one audio stream to multiple listeners: that is the model that killed turntable.fm.
- Spotify: Web Playback SDK, Premium per user, Dev Mode capped at 5 users (Feb 2026), extended access approval required to grow.
- Apple Music: MusicKit JS, per-user subscription, JWT developer token.
- YouTube: visible IFrame embed only. No audio extraction, no background playback (TOS).
- YouTube Music: no official API. Do not integrate via ytmusicapi (cookie-based, TOS-violating).
- Deezer: API closed to new apps since ~2024. Unsupportable until reopened.
- Cross-service masters differ: ±500ms baseline offset is physics, not a bug.
- Track identity across services: ISRC (Spotify/Apple expose it), MusicBrainz fallback, fuzzy match for YouTube.

## Working agreements (XP + TDD + observability)

- **XP cadence** (/xp): one small task per cycle: plan (confirm what/why/how) → one failing test → minimal code → refactor under green → small commit. Cycle >30 min = split it. Signal-first handoff after cycles.
- **TDD** (/tdd): no production code without a failing test first, watched failing. Vertical slices (one test + one impl per cycle), tests target public interfaces (queue reducer, match confidence, RPC handlers via centrifuge test client), never mock internals. Server: `go test -race ./...`; web: Vitest; e2e: Playwright two-browser room scenarios.
- **Observability** (/observe, MVP-light by design): Go server uses `log/slog` JSON structured logs (request + RPC + room lifecycle events with `room_id`, `client_id`, `method`, `duration_ms`) and `prometheus/client_golang` at `/metrics` (rooms active, connections, RPC count/latency, match confidence histogram). Backend: self-hosted Grafana/Loki/Prometheus on homelab when deployed; log to stdout, scrape /metrics. Full OTEL tracing deferred until multi-service.
- Exception: the initial tracer-bullet scaffold predates these agreements; from Phase 1 on they bind.

## Brain back-link

Centralized knowledge-brain: memory pool tagged `project/music-jam` (`knowledge-brain/memory/music-jam-*.md`), graph at `knowledge-brain/graphs/music-jam/` (symlinked as `graphify-out/`).
