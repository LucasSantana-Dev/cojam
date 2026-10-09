# Configuration

Every feature is gated behind a flag, and all match providers are optional: with a provider's keys unset, matching is skipped silently and rooms still work with manual track entry.

## Web

Build-time, in `apps/web/.env.local`:

```bash
NEXT_PUBLIC_FEATURE_YOUTUBE=true       # default true
NEXT_PUBLIC_FEATURE_SPOTIFY=false      # default false
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
| `SPOTIFY`, `LISTENBRAINZ`, `LASTFM_ENRICH`, `SYNC`, `ROOM_AUTH`, `QUEUE_VOTING`, `ROOM_CHAT`, `PUBLIC_ROOMS`, `TELEMETRY`, `VIDEO` | off |

`VIDEO` is its own flag, not `SYNC`: video co-watch carries a ToS exposure and must switch off without disabling audio drift correction.

## Server

Environment:

```bash
APP_ENV=production                     # strict config validation; refuses unsafe boots
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
FEATURE_MATCHING=true
ROOM_IDLE_TTL_MINUTES=30               # evict memberless rooms idle this long
ROOM_PERSIST_IDLE_TTL_MINUTES=0        # delete memberless room ROWS idle this long (0=disabled, opt-in; single-instance only)
REPORT_RETENTION_DAYS=0                # delete reports and moderation actions older than this (0=keep forever)
LOG_LEVEL=info                         # debug | info | warn | error (default info)
YOUTUBE_API_KEY=<key>                  # YouTube matching
SPOTIFY_CLIENT_ID=<id>                 # Spotify matching (client credentials)
SPOTIFY_CLIENT_SECRET=<secret>
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

### Retention

Both retention windows default to **keep forever**. Deleting data is an owner decision, and the privacy policy must state the values production actually runs with. A production boot (`APP_ENV=production`) warns when either is unset or 0.

| Variable | What it deletes | Default |
| --- | --- | --- |
| `ROOM_PERSIST_IDLE_TTL_MINUTES` | Persisted room rows (queue, added-by names and ids, votes, host id, room name) with no connected member and no change for this long. Everything a room holds about a person lives in that one row. | `0` (keep). The policy intends 30 days, `43200`. |
| `REPORT_RETENTION_DAYS` | `reports` and `moderation_actions` rows older than this many days, by `created_at`. | `0` (keep) |

`REPORT_RETENTION_DAYS` must be a whole number from 0 to 36500; anything else refuses to start, because a typo that silently kept data forever would make the policy false. The purge runs once at boot and then hourly. Each `DELETE` is bounded to 5000 rows, oldest first; a run repeats while batches come back full, up to 10 per table, and logs `retention_backlog` if rows past the window remain for the next run. Logs carry counts only, and `music_jam_retention_purged_total{table}` counts deleted rows.

> [!CAUTION]
> The first run happens at boot and deletes immediately. A typo such as `1` for `100` destroys reports that cannot be recovered. Check the value (it is logged as `report_retention_enabled window_days=...`) before deploying.

The purge is by age only. Neither table has a status or resolution column, so a report tied to an open case is purged on the same schedule as any other: holding one longer (legal hold) is not supported, and the window has to be long enough for ECA Digital reporting duties (#259). That length is a question for legal review.

Room idleness is measured by the last change to the row, not the last visit. A room someone opened within the in-memory window (`ROOM_IDLE_TTL_MINUTES`) without changing anything is still held in memory, and a later change saves it again.

### Erasing one person's data (LGPD)

`server erase` is an operator subcommand of the server binary (#318). It connects with `DATABASE_URL`, runs in one transaction, and prints counts per table only.

```bash
server erase --sub <guest id> [--name <display name>] [--client-id <id>]... [--include-subject-reports] --dry-run
server erase --sub <guest id> [--name <display name>] [--client-id <id>]... [--include-subject-reports] --apply
```

It deletes the person's Spotify token row; removes their votes, host role and queue attribution from persisted rooms (names become "Removido"); anonymizes them as the reporter of reports and as the actor or subject of moderation actions. A display name (`--name`) only matches inside rooms where the person's id or a given client id was found, since names are not unique. Reports **about** the person are kept as evidence under a legal obligation (LGPD art. 7 II, art. 16 I) unless `--include-subject-reports` is passed, and moderation rows tied to a kept report stay with it. `[[REVISAR]]` that default with legal review. Stop the server before `--apply`: a room held in memory would write the person back. The guest id is shown to the person on the landing page under "Seus dados". The full procedure is the operator runbook `docs/runbooks/lgpd-erasure.md` (kept out of git, like the other runbooks).

## Observability

Set `REPORT_WEBHOOK_URL` to push a minimal summary of each member report (id, kind, room id, category, time; no chat content) to a channel you monitor. Unset means reports are stored and logged only.

The Go server emits structured JSON logs to stdout. Every line carries `service=cojam-server` and `version` (the build stamp). `LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`) sets the minimum level, including for the realtime library's own logs; an unrecognized value logs a config warning and uses `info`. Every HTTP request gets an id: the caller's `X-Request-Id` when it is 8 to 64 URL-safe characters, otherwise a random one. It is echoed in the response header and written as `request_id` on the access log line. Logs carry no client addresses, no search text, no track titles or artists, and no user ids.

Prometheus metrics are served at `/metrics` on a dedicated listener when `METRICS_ADDR` is set (never on the public port). The full series list is in [observability-metrics.md](observability-metrics.md).
