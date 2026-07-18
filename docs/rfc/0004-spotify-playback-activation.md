# RFC-0004: Activate Spotify playback

Status: proposed (2026-07-18)
Pipeline: ralphinho-rfc-pipeline. Fourth RFC after 0001 persistence, 0002 synchronized playback, 0003 audiophile Phase 2.

## Summary

The Spotify Web Playback SDK adapter, OAuth PKCE auth, `IPlayer` implementation, per-track
source selection, and server-side ISRC-first matcher **already exist and are correct in
isolation**. Spotify playback is nonetheless **dead in the normal production config** because
of a single wiring defect: the server only wires the Spotify matcher inside the `else` branch
of the YouTube-key guard, so whenever `YOUTUBE_API_KEY` is set (the day-1 platform), tracks
never receive a `spotify.trackUri` and the client can never select the Spotify adapter.

This RFC activates the existing path: fix the wiring so both matchers run independently, then
close the genuine gaps that stand between "flag flipped" and "a Premium user actually hears
synced audio": account-tier gating, presence platform badges, and honest unavailable-track UX.

Ships **DARK** behind the existing `FEATURE_SPOTIFY` (server) / `NEXT_PUBLIC_FEATURE_SPOTIFY`
(web) flags, both default OFF. No behavior change until an operator flips both.

## Motivation

- Spotify is the highest-value platform; CoJam plays only YouTube audio in practice today.
- The groundwork already shipped (RFC-0002 U2 adapters + prior auth work). The remaining work
  is activation and hardening, not construction.
- The dead-wiring defect is the same class as the matcher-else-branch trap already fixed once
  this project (dead-in-prod provider wiring). Fixing it is a real correctness win independent
  of the feature flag.

## Current state (verified 2026-07-18)

| Piece | State | Evidence |
|---|---|---|
| `IPlayer` interface | complete, 8 methods | `apps/web/lib/playerInterface.ts` |
| Spotify adapter | complete (SDK load, device reg, play/pause/seek via REST, position poll, dispose) | `apps/web/app/room/components/SpotifyPlayer.tsx` |
| Spotify OAuth PKCE + `streaming` scope + 127.0.0.1 redirect + token refresh | complete | `apps/web/lib/spotifyAuth.ts` |
| Per-track source pick (Spotify > Apple > YouTube) | complete | `apps/web/lib/pickSource.ts` |
| Server ISRC-first Spotify matcher + independent hub setter | complete but **not wired in the YouTube-on path** | `internal/match/match.go:436`, `internal/hub/hub.go:373,867` |
| `enrichSpotify` on add + advance | complete, no-ops because `spotifyMatcher` is nil in prod | `hub.go:373-374,705-706,915` |
| Premium-tier gate | **missing** (only a generic `account_error` state) | `SpotifyPlayer.tsx:185,210` |
| Presence platform badge | **missing** (`Member` has name only) | `apps/web/lib/realtime.ts`, `PresenceBar.tsx` |
| Unavailable-track UX | **missing** (silent no-op when `pickSource` returns null) | `client.tsx` |

## The defect (U1 target)

`apps/server/cmd/server/main.go:144-183`:

```
if FEATURE_MATCHING && YOUTUBE_API_KEY != "" {
    h.WithMatcher(youtube)          // YouTube wired
} else {
    if FEATURE_MATCHING && SPOTIFY_CLIENT_ID/SECRET { h.WithSpotifyMatcher(spotify) }  // only reachable when YouTube is OFF
}
```

Consequence: production runs with `YOUTUBE_API_KEY` set, so the `else` never executes,
`h.spotifyMatcher == nil`, `enrichSpotify` never runs, `sources.spotify.trackUri` stays empty,
`pickSource` never returns `spotify`, and the fully-built adapter is unreachable.

Fix: wire the two matchers independently at top level, each gated only by its own credentials.

## Work units

### U1 - Decouple the Spotify matcher wiring (Tier 3, CRITICAL, unblocker)
- **scope:** `apps/server/cmd/server/main.go` - lift `WithSpotifyMatcher` out of the YouTube
  `else` so YouTube and Spotify matchers wire independently, each on its own credential guard.
  Preserve the existing cache wrapper + metrics + log lines.
- **depends_on:** none. Everything else is cosmetic until this lands.
- **acceptance_tests:** with both `YOUTUBE_API_KEY` and `SPOTIFY_CLIENT_ID`/`SECRET` set, boot
  logs emit both `matcher_enabled provider=youtube` and `spotify_matcher_enabled`; a queued
  track with a known ISRC receives both `sources.youtube.videoId` and `sources.spotify.trackUri`
  (hub-level test with a stub Spotify matcher asserting `enrichSpotify` fires when
  `spotifyMatcher != nil` alongside the YouTube matcher).
- **risk_level:** medium (touches boot wiring; the class of bug that hides in prod-only config).
- **rollback_plan:** revert the single commit; wiring returns to prior (Spotify-only-when-YouTube-off).

### U2 - Premium account gate + honest degrade (Tier 2)
- **scope:** `SpotifyPlayer.tsx` (+ small `spotifyAuth`/util helper) - after auth, call
  `GET /v1/me`, read `product`; if not `premium`, surface a clear "Spotify Premium required to
  play here" state and report unauthorized-for-playback so `pickSource` falls back to YouTube
  for that user. Premium proceeds unchanged.
- **depends_on:** none (client-only). Parallel with U1.
- **acceptance_tests:** free-tier `product` → clear message + no active Spotify player + YouTube
  fallback selected; premium `product` → adapter becomes active. Unit test the tier→decision
  helper with mocked `/v1/me`.
- **risk_level:** low. **rollback_plan:** revert; behavior returns to generic account_error.

### U3 - Presence platform badges (Tier 2)
- **scope:** extend `Member` with `platform: 'spotify'|'apple'|'youtube'`; broadcast the active
  source via centrifuge presence ConnInfo on subscribe/source-change; render a small badge in
  `PresenceBar.tsx`. Backward compatible (absent platform → no badge).
- **depends_on:** none. Parallel with U1/U2.
- **acceptance_tests:** two clients on different services each show the correct badge; a client
  with no known platform shows name only (no crash). Test the ConnInfo encode/decode + render.
- **risk_level:** low. **rollback_plan:** revert; presence returns to name+count.

### U4 - Unavailable-track UX (Tier 2)
- **scope:** `client.tsx` (+ small component) - when `pickSource(nowPlaying)` returns null for
  this client, show a clear "not available on your connected services" state for the now-playing
  hero instead of a silent dead player. No auto-skip (host-controlled advance stays authoritative).
- **depends_on:** none technically, but shares `client.tsx` with U2's fallback wiring - sequence
  after wave 1 or run in a worktree to avoid a merge conflict.
- **acceptance_tests:** a Spotify-only track (no youtube source) shows YouTube-only users the
  unavailable state; a playable track shows the normal hero.
- **risk_level:** low. **rollback_plan:** revert; silent no-op returns.

### U5 - Enablement runbook + flag reconciliation (Tier 1)
- **scope:** `docs/` runbook: required env (server `SPOTIFY_CLIENT_ID`/`SECRET` + `FEATURE_SPOTIFY`;
  web `NEXT_PUBLIC_FEATURE_SPOTIFY` + runtime `COJAM_SPOTIFY_CLIENT_ID`), the Premium requirement,
  the dev-mode 5-user cap (Feb 2026) and extended-access path, and the 127.0.0.1 redirect note.
  Reconcile the plan/README lines that say "YouTube-only until Spotify adapter."
- **depends_on:** U1-U4 (documents the activated state).
- **acceptance_tests:** a fresh operator can flip Spotify on from the runbook alone.
- **risk_level:** none (docs). **rollback_plan:** n/a.

## Dependency graph

```
U1 (unblocker) ──┐
U2 ──────────────┤
U3 ──────────────┼──> U4 ──> U5 (docs, last)
                 │     (U4 sequenced after U2 for client.tsx)
```

- **Wave 1 (parallel):** U1, U2, U3 - independent files (server main.go / SpotifyPlayer+util / realtime+PresenceBar).
- **Wave 2:** U4 (after U2 lands, shares client.tsx).
- **Wave 3:** U5 docs, then RFC doc PR.

## Out of scope (do not resurrect silently)

- **Device picker** (choose which Spotify Connect device plays): the web SDK self-registers a
  "cojam" device and playback targets it; a multi-device picker is a later polish RFC, not needed
  to hear audio.
- **Spotify as the sync master / cross-service tight sync:** governed by RFC-0002 (ships dark);
  this RFC only makes Spotify a valid per-user player, it does not change the transport model.
- **Extended-access / >5 user growth:** an operator/legal step (Spotify approval), not code.
- **Removing YouTube fallback:** YouTube stays the universal fallback.

## Legal / platform notes

- Per-user stream synchronized by metadata (Stationhead/Vertigo model) - unchanged. Spotify audio
  plays on each Premium user's own account via the Web Playback SDK; no rebroadcast.
- Spotify Dev Mode caps at 5 users (Feb 2026). Extended access requires Spotify approval before
  growing beyond that. Code ships dark; enabling for real users is an operator decision.
