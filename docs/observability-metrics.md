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
| `music_jam_goroutine_panics_total` | `where` | Panics recovered in a background goroutine (`hub_enrich`, `hub_evict`, `hub_heartbeat`, `hub_radio`, `match_search`, `report_notify`, `report_retention`, `moderation_audit`, `search_purge`). Should stay 0; each also logs `goroutine_panic` with a trimmed stack. |

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
| `music_jam_retention_purged_total` | `table` | Rows deleted by the retention sweep (`reports`, `moderation_actions`). |

## Client telemetry

| Series | Labels | Meaning |
| --- | --- | --- |
| `music_jam_client_errors_total` | `name` | Browser-reported errors, allowlisted names only. |
| `music_jam_product_events_total` | `name` | Funnel events, allowlisted names only. |
| `music_jam_web_vitals` | `name` | Core Web Vitals histogram (LCP and INP in ms, CLS unitless). |
| `music_jam_telemetry_rejected_total` | `reason` | Telemetry posts rejected. A spike means a misbehaving client. |
