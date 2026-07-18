# Runbook: enabling Spotify playback

Spotify playback ships **dark** by default. The adapter, OAuth, matcher, and UI all exist
(RFC-0004); this runbook is the operator checklist to turn it on. Nothing here changes behavior
until you set the flags below.

## What "on" gives you

- Each Premium listener plays the track on their own Spotify account via the Web Playback SDK
  (per-user stream, metadata-synced; no rebroadcast).
- Free-tier accounts are detected and degraded to the YouTube fallback with a clear message.
- Presence shows a per-listener platform badge (Spotify / Apple / YouTube).
- A track with no source a given listener can play shows an explicit "not available on your
  connected services" state instead of a silent dead player.

## Prerequisites

1. A Spotify app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. **Redirect URI** registered exactly as the app serves it. Spotify bans `localhost`; the web
   app rewrites `localhost:<port>` to `127.0.0.1:<port>` (`canonicalOrigin`), so register the
   `http://127.0.0.1:<port>/callback/spotify` form for local dev, and the real
   `https://<host>/callback/spotify` for production.
3. Each real listener needs **Spotify Premium**. Free accounts cannot stream via the SDK.
4. **Dev Mode caps the app at 5 users** (Spotify, Feb 2026). Beyond that you must apply for
   Spotify **extended access** and be approved. Keep the app in Dev Mode until then.

## Configuration

### Server (`apps/server`)

| Variable | Purpose |
|---|---|
| `FEATURE_SPOTIFY=true` | Enables the Spotify path server-side. |
| `FEATURE_MATCHING=true` | Must be on (default true) for any matcher to run. |
| `SPOTIFY_CLIENT_ID` | From the Spotify app. Enables the server Spotify matcher. |
| `SPOTIFY_CLIENT_SECRET` | From the Spotify app. Required alongside the id. |

With both credentials set, the server wires the Spotify matcher **independently of YouTube**
(RFC-0004 U1). Confirm at boot: the log emits `spotify_matcher_enabled provider=spotify`
(and `matcher_enabled provider=youtube` if `YOUTUBE_API_KEY` is also set). If you instead see
`spotify_matcher_disabled`, a credential is missing.

### Web (`apps/web`)

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_FEATURE_SPOTIFY=true` | Enables the Spotify UI (connect button, adapter). Build-time or via runtime `env.js`. |
| `COJAM_SPOTIFY_CLIENT_ID` | Runtime client id injected via `/env.js` (`window.__COJAM_ENV__`) so one built image works per host. |
| `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` | Build-time fallback client id if the runtime value is absent. |

The web image is env-agnostic: set `COJAM_SPOTIFY_CLIENT_ID` (and `COJAM_WS_URL`) at deploy time,
no rebuild needed.

## Enable checklist

1. Register the app + redirect URI (see Prerequisites).
2. Server: set `FEATURE_SPOTIFY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`; restart; confirm
   `spotify_matcher_enabled` in logs.
3. Web: set `NEXT_PUBLIC_FEATURE_SPOTIFY` + a client id (runtime `COJAM_SPOTIFY_CLIENT_ID` or the
   build-time fallback).
4. Load a room as a Premium user, click **Connect Spotify**, complete OAuth (lands on
   `127.0.0.1` locally), queue a track with a known ISRC, confirm it plays on Spotify and the
   presence badge shows Spotify.
5. Verify a non-Premium account degrades to YouTube with the Premium-required message.
6. Stay within the 5-user Dev Mode cap until extended access is approved.

## Rollback

Unset `FEATURE_SPOTIFY` (server) and `NEXT_PUBLIC_FEATURE_SPOTIFY` (web), restart. The Spotify UI
disappears and playback falls back to YouTube. The matcher wiring is harmless when disabled.

## Notes

- The per-user-stream + metadata-sync model is unchanged (Stationhead/Vertigo precedent).
- Tight cross-service playhead sync is a separate feature (RFC-0002, also dark behind `FEATURE_SYNC`).
- Provider RPCs are covered by httptest mocks; a live smoke test against the real Spotify API is a
  sensible follow-up once enabled.
