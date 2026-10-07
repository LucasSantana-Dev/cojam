# Configuration

Every feature is gated behind a flag, and all match providers are optional: with a provider's keys unset, matching is skipped silently and rooms still work with manual track entry.

## Web

Build-time, in `apps/web/.env.local`:

```bash
NEXT_PUBLIC_FEATURE_YOUTUBE=true       # default true
NEXT_PUBLIC_FEATURE_SPOTIFY=false      # default false
NEXT_PUBLIC_FEATURE_APPLE=false        # default false
NEXT_PUBLIC_FEATURE_PRESENCE=true      # default true
NEXT_PUBLIC_SPOTIFY_CLIENT_ID=<id>     # Spotify PKCE (Web Playback)
NEXT_PUBLIC_WS_URL=ws://localhost:8080/connection/websocket
```

`NEXT_PUBLIC_*` are inlined at build time. A deployed image is configured at runtime instead, via `COJAM_*` vars served through `/env.js` (no rebuild):

```bash
COJAM_WS_URL=wss://example.com/connection/websocket
COJAM_FEATURE_<NAME>=true|false        # runtime override per feature flag
COJAM_SUPABASE_URL=<url>               # accounts; emitted only with the anon key
COJAM_SUPABASE_ANON_KEY=<key>
COJAM_FEATURE_SUPABASE_AUTH=false      # suppress the Supabase pair entirely
COJAM_FEATURE_TELEMETRY=true           # client error/vitals/event reporting (default off)
```

> [!IMPORTANT]
> The client treats the presence of the Supabase pair as "accounts available". Set `COJAM_FEATURE_SUPABASE_AUTH=false` whenever the server runs with `FEATURE_SUPABASE_AUTH=false`, or the UI offers a sign-in the server will refuse.

### Web feature flags

Source of truth: `apps/web/lib/features.ts`. Each has a `NEXT_PUBLIC_FEATURE_<NAME>` build-time key and a `COJAM_FEATURE_<NAME>` runtime key. Values `1/true/on/yes` and `0/false/off/no` are accepted.

| Flag | Default |
| --- | --- |
| `YOUTUBE`, `PRESENCE`, `TRACK_DEPTH`, `LYRICS` | on |
| `SPOTIFY`, `APPLE`, `LISTENBRAINZ`, `LASTFM_ENRICH`, `SYNC`, `ROOM_AUTH`, `QUEUE_VOTING`, `ROOM_CHAT`, `PUBLIC_ROOMS`, `TELEMETRY`, `VIDEO` | off |

`VIDEO` is its own flag, not `SYNC`: video co-watch carries a ToS exposure and must switch off without disabling audio drift correction.

## Server

Environment:

```bash
APP_ENV=production                     # strict config validation; refuses unsafe boots
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
FEATURE_MATCHING=true
ROOM_IDLE_TTL_MINUTES=30               # evict memberless rooms idle this long
ROOM_PERSIST_IDLE_TTL_MINUTES=0        # delete memberless room ROWS idle this long (0=disabled, opt-in; single-instance only)
YOUTUBE_API_KEY=<key>                  # YouTube matching
SPOTIFY_CLIENT_ID=<id>                 # Spotify matching (client credentials)
SPOTIFY_CLIENT_SECRET=<secret>
APPLE_TEAM_ID=<team>                   # Apple MusicKit token (when enabled)
APPLE_KEY_ID=<id>
APPLE_PRIVATE_KEY_PATH=/path/to/key
SPOTIFY_TOKEN_KEY=<base64 32 bytes>    # seals stored Spotify refresh tokens
```

### Server feature flags

Read in `apps/server/cmd/server/main.go`. Same truthy and falsy values as the web.

| Flag | Default |
| --- | --- |
| `FEATURE_MATCHING`, `FEATURE_PLAYLIST_IMPORT`, `FEATURE_RADIO`, `FEATURE_TRACK_DEPTH`, `FEATURE_LYRICS` | on |
| `FEATURE_SYNC`, `FEATURE_QUEUE_VOTING`, `FEATURE_ROOM_CHAT`, `FEATURE_PUBLIC_ROOMS`, `FEATURE_VIDEO`, `FEATURE_ROOM_AUTH`, `FEATURE_SUPABASE_AUTH`, `FEATURE_LISTENBRAINZ`, `FEATURE_LASTFM_ENRICH` | off |

> [!IMPORTANT]
> `SPOTIFY_TOKEN_KEY` must be base64 of exactly 32 bytes (`openssl rand -base64 32`) and must be kept **separate from `DATABASE_URL`**, so leaking one does not imply leaking the other. Unset means no server-side custody: playback still works for the lifetime of one access token, then the user reconnects. Refusing is deliberate, because storing a long-lived credential in the clear is worse than not storing it.

## Observability

The Go server emits structured JSON logs to stdout. Prometheus metrics are served at `/metrics` on a dedicated listener when `METRICS_ADDR` is set (never on the public port).
