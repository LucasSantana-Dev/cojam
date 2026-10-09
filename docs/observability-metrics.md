# Metrics inventory

Every series the Go server exposes on `/metrics` (the `METRICS_ADDR` listener only, see ADR-0004). Series are registered in `apps/server/internal/obs`. Label values are bounded enums or allowlisted names; free text never becomes a label. Known label combinations are initialised at zero at boot, so `rate()` and `absent()` see them before the first event.

## Runtime

| Series | Labels | Meaning |
| --- | --- | --- |
| `go_*` | | Go runtime: goroutines, GC, heap, threads. |
| `process_*` | | Process: CPU seconds, resident memory, open and max file descriptors, start time. |
| `music_jam_db_pool_acquired_conns` | | Postgres connections checked out (gauge). Absent in in-memory mode. |
| `music_jam_db_pool_idle_conns` | | Idle pooled connections (gauge). |
| `music_jam_db_pool_total_conns` | | Connections in the pool (gauge). |
| `music_jam_db_pool_max_conns` | | Configured pool limit (gauge). |
| `music_jam_db_pool_acquire_total` | | Successful acquires (counter). |
| `music_jam_db_pool_acquire_seconds_total` | | Cumulative time spent acquiring (counter). |
| `music_jam_db_pool_empty_acquire_total` | | Acquires that waited because no connection was idle (counter). Rising means the pool is too small. |
| `music_jam_goroutine_panics_total` | `where` | Panics recovered in a background goroutine (`hub_enrich`, `hub_evict`, `hub_heartbeat`, `hub_radio`, `events_writer`, `match_search`, `report_notify`, `report_retention`, `moderation_audit`, `search_purge`). Should stay 0; each also logs `goroutine_panic` with a trimmed stack. |

## Rooms and realtime

| Series | Labels | Meaning |
| --- | --- | --- |
| `music_jam_rpc_duration_seconds` | `method`, `status` | Room RPC latency histogram. Status is `ok`, `error` (server fault) or `user_error`. |
| `music_jam_connections_active` | | Connected realtime clients (gauge). |
| `music_jam_rooms_active` | | Rooms held in hub memory (gauge). |
| `music_jam_rate_limit_rejected_total` | `method` | RPCs rejected by a per-caller limiter. |
| `music_jam_rooms_evicted_total` | | Idle rooms evicted from memory. |
| `music_jam_rooms_persisted_evicted_total` | | Idle room rows deleted from the store. |
| `music_jam_room_playing_without_transport_total` | | Rooms found playing with no sync clock. Should be about 0. |
| `music_jam_publish_duration_seconds` | | Room channel publish latency histogram (1 ms to 2.5 s). |
| `music_jam_publish_errors_total` | | Failed channel publications. |

## Store

| Series | Labels | Meaning |
| --- | --- | --- |
| `music_jam_store_save_duration_seconds` | | Postgres room Save latency histogram (1 ms to 2.5 s). Includes heartbeat and mutation saves. |
| `music_jam_store_errors_total` | `op` | Store failures, `load` or `save`. |
| `music_jam_store_version_guard_rejected_total` | | Stale saves dropped by the version guard. |

## Providers (outbound HTTP)

| Series | Labels | Meaning |
| --- | --- | --- |
| `music_jam_provider_requests_total` | `provider`, `op`, `status` | Outbound calls. `provider`: `youtube`, `spotify`, `deezer`, `lyrics`, `other` (MusicBrainz, Last.fm, ListenBrainz, JWKS). `op`: `search`, `lookup`, `playlist`, `token`, `lyrics`, `similar`, `isrc`, `jwks`, `other`. `status`: `ok`, `error`, `quota`, `ratelimit`, `timeout`. |
| `music_jam_provider_request_duration_seconds` | `provider`, `op` | Outbound call latency histogram (50 ms to 10 s). |
| `music_jam_youtube_quota_trips_total` | `kind` | Times the YouTube quota breaker opened, `daily` or `transient`. |
| `music_jam_youtube_quota_open` | | 1 while the breaker is open, else 0 (gauge). |
| `music_jam_match_confidence` | | Cross-catalog match confidence histogram (0 to 1). |
| `music_jam_match_cache_hits_total` | | Matcher cache hits. |
| `music_jam_match_cache_misses_total` | | Matcher cache misses. |

A YouTube 403 counts as `quota` only when the body says `quotaExceeded` or `dailyLimitExceeded`, and as `ratelimit` for `rateLimitExceeded`; any other 403 is `error`.

## Adoption and moderation

| Series | Labels | Meaning |
| --- | --- | --- |
| `music_jam_votes_cast_total` | | `queue.vote` toggles applied. |
| `music_jam_chat_messages_sent_total` | | Chat messages sent. |
| `music_jam_rooms_listed_total` | | `room.list` reads served. |
| `music_jam_rooms_set_public_total` | `public` | `room.set_public` toggles, by target visibility. |
| `music_jam_rooms_shared_total` | | Rooms that gained a first non-creator member. |
| `music_jam_reports_filed_total` | `kind` | Member reports filed (`message`, `member`, `room`). |
| `music_jam_retention_purged_total` | `table` | Rows deleted by the retention sweep (`reports`, `moderation_actions`, `product_events`). |

## Client telemetry

| Series | Labels | Meaning |
| --- | --- | --- |
| `music_jam_client_errors_total` | `name` | Browser-reported errors, allowlisted names only. |
| `music_jam_product_events_total` | `name` | Funnel events, allowlisted names only. |
| `music_jam_web_vitals` | `name` | Core Web Vitals histogram (LCP and INP in ms, CLS unitless). |
| `music_jam_telemetry_rejected_total` | `reason` | Telemetry posts rejected. A spike means a misbehaving client. |
| `music_jam_sync_drift_seconds` | `player`, `platform` | Absolute playback drift (actual minus expected position) sampled by browsers, buckets 0.25, 0.5, 1, 2, 5, 10, 30, 120 s. `player`: `youtube`, `spotify`. `platform`: `mobile`, `desktop`. |
| `music_jam_sync_drift_samples_total` | `player`, `platform`, `hidden` | Drift samples received. `hidden` is `true` when the tab was in the background. All combinations start at 0. |

`telemetry_rejected_total` reasons: `rate_limited`, `malformed` (not JSON, or a `sample` with an unknown field), `unknown_type`, `unknown_name`, `invalid_sample` (bad enum, out-of-range drift or rtt, missing flag).

### Sync drift sample

Sent by the browser as `{"type":"sample","name":"sync_drift","driftMs":-420,"player":"youtube","canSeek":true,"hidden":false,"rttMs":38,"platform":"mobile"}`. No room id, track id, URL or user data; the server rejects any other field. `driftMs` is signed (negative means the player is behind) and clamped to +/-600000; only its absolute value is observed. `canSeek` and `rttMs` are accepted and validated but not labels (cardinality), so they are not queryable today.

Cadence per listener: about 3 s after each track change, then every 30 s while a track plays with a transport, plus one about 1.5 s after a corrective seek and one about 2 s after the page comes back. Never faster than one per 3 s, under the endpoint's 20 burst / 3 s bucket. Players that cannot seek (Spotify free) are sampled too. Individual samples are logged at debug level only.

Useful queries: p95 drift `histogram_quantile(0.95, sum by (le, player, platform) (rate(music_jam_sync_drift_seconds_bucket[1h])))`; share of background samples `sum(rate(music_jam_sync_drift_samples_total{hidden="true"}[1h])) / sum(rate(music_jam_sync_drift_samples_total[1h]))`.

### Turning it on in production

- Web: `COJAM_FEATURE_TELEMETRY=true` (runtime, via `/env.js`, default off). Drift also needs `COJAM_FEATURE_SYNC=true`, since sampling rides the sync loop's transport.
- Server: no flag. `POST /api/telemetry` is always mounted; with the web flag off nothing is sent.

`track_added`, `provider_connected` (events) and `ws_terminal`, `playback_failed` (errors) are now emitted by the client: after a successful `queue.add`, after the Spotify callback exchange or an explicit "Ouvir no" switch, on a non-zero terminal disconnect code that is not a kick, and on a YouTube unplayable error or a Spotify `playback_error`.

## Product events (first-party table)

Distinct from the browser funnel above (`music_jam_product_events_total`, Prometheus counts only): these are rows in Postgres, `product_events`, written by the server. Owner decision 2026-10-09; the privacy page (`/privacidade`, sections 3, 4, 5 and 8) and spec 253 section 8 describe them to users. Code: `apps/server/internal/events`, emit points in `apps/server/internal/hub/events.go`.

| Series | Labels | Meaning |
| --- | --- | --- |
| `music_jam_events_written_total` | `name` | Events inserted into `product_events`, by event name. |
| `music_jam_events_dropped_total` | `reason` | Events discarded: `buffer_full` (5000 waiting rows), `db_error` (insert failed or shutdown flush timed out), `disabled` (`FEATURE_PRODUCT_EVENTS` off or no database). Anything but `disabled` above 0 is worth a look. |

Table `product_events` (migration `0008_product_events.sql`): `id bigserial`, `at timestamptz`, `name text`, `room_hash text`, `actor_hash text`, `props jsonb`. Indexes `(name, at)` and `(at)`. RLS on, no policies. `room_hash` and `actor_hash` are the first 16 bytes (32 hex) of HMAC-SHA256 keyed by `EVENTS_HMAC_KEY` over `room:<room id>` and `actor:<identity>`; NULL when unknown. Never stored: IP, nickname, chat, search text, clear room id. Rows older than 13 months (396 days) are purged hourly by the retention sweep.

| Event | Props | Emitted from | Actor |
| --- | --- | --- | --- |
| `room_created` | | `getOrLoadRoom`, when the room existed in neither memory nor store | none |
| `room_joined` | (`via` is omitted: the server cannot know it) | `Hub.Join`, on a new membership | `user:<id>` or `client:<connection id>` |
| `track_started` | `provider` `youtube`/`spotify`/`other`, `source` `manual`/`radio`/`autoplay`/`history` | `mutateRoom`, whenever `NowPlayingID` changes to a track | none |
| `track_skipped` | `by` `host`/`auto`/`vote` | `advanceAfterReport` | caller for `host`, the voter who tipped the threshold for `vote`, none for `auto` |
| `track_liked` | | `reactionWoot` | `user:<id>` or `client:<id>` |
| `search` | `provider` `catalog` (typed search, `track.search`) or `youtube`/`spotify` (source lookup via the matcher, `cache_hit` meaningful), `cache_hit` bool | `dispatch` and the matcher callbacks in `main.go` | caller for `catalog`, none for lookups |
| `provider_connected` | `provider` `spotify` | `spotifyExchangeHandler`, after Spotify accepts the code | `user:<connection sub>` |
| `listener_peak` | `n` | `peakTracker`, once per room per UTC hour | none |

Semantics worth knowing before building a panel:

- `provider` on `track_started` is the only source the track carries when it starts; "other" means both or neither. The service a listener plays on is chosen per client ("Ouvir no") and unknown to the server.
- `source` `manual` means the room was idle and someone queued or re-picked the track; `autoplay` means it followed another track; `radio` and `history` come from the track's origin.
- `track_skipped` `by=host` is an advance more than 15 s before the catalogue end of a track with a known duration and a transport (the web skip button and the end-of-track advance share one RPC). Without a transport (sync off) or a duration nothing is recorded. `by=auto` covers the sourceless auto skip and `now_playing.skip_unplayable`. `by=vote` is the same early-advance check when the `now_playing.vote_skip` threshold advances the track (`hub/skipvote.go`).
- `listener_peak.n` is the highest number of concurrent members seen at a join during the hour (one connection counts once), stamped with the start of that hour. A room that nobody rejoins is flushed within about 5 minutes after its hour ends, and at shutdown.
- Guests without room auth get `actor_hash` per connection, so a returning guest is a new actor. With `FEATURE_ROOM_AUTH` the actor is the stable anonymous or account sub.

Configuration: `FEATURE_PRODUCT_EVENTS` (default on when `DATABASE_URL` is set, always off in in-memory mode), `EVENTS_HMAC_KEY` (32+ random bytes; unset generates a random key per boot and logs `events_hmac_key_unset`, so hashes do not match across restarts). Dashboards read through the `grafana_ro` role (`observability/postgres/grafana-ro.sql`, verified by `observability/postgres/test-grafana-ro.sh`).
