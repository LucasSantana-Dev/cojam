# Guest-path audit (F2 / issue #128)

Date: 2026-07-22. Method: static code read of `apps/web`, `apps/server`, `packages/shared`; no servers run. Scope: the name-only guest path (no Supabase account) end to end: join, capabilities, persistence, friction, gaps vs accounts. "Guest" here means a user on the anonymous room-auth identity (or no identity at all when `FEATURE_ROOM_AUTH` is off).

## 1. Join and identity

- Join UX is a single name-entry card on the room page (`apps/web/app/room/[id]/client.tsx:273-351`): room code chip, avatar preview, name input, "Join & Play". There is no approval/waiting room; the e2e specs call this card the "waiting-room card" (`apps/web/e2e/room-sync.spec.ts:8`) but it is only the name form. Any name is accepted; there is no server-side name validation or uniqueness check (`room.join` in `apps/server/internal/hub/hub.go:601-629` ignores `name` entirely; the name travels only as presence metadata).
- Token resolution order (`apps/web/lib/realtime.ts:106-114`): Supabase account token wins, else anonymous room-auth token from `GET /api/connection-token` (only when `roomAuthEnabled` resolves on), else empty string (v0 behavior, allowed only when the server has `FEATURE_ROOM_AUTH` off; `apps/server/cmd/server/main.go:368`).
- Anonymous identity shape: `sub` = 16 random bytes, base64url-encoded, 22 chars (`apps/server/internal/connauth/connauth.go:142-150`). HS256 JWT, 24h TTL (`apps/server/cmd/server/connection_token.go:49`). The server sets centrifuge `UserID` to this sub (`apps/server/cmd/server/main.go:355-366`).
- Identity continuity: the web app stores `cojam_uid` and `cojam_token` in `localStorage` (`apps/web/lib/auth.ts:6-7`) and presents the previous token as an ownership proof (`?userId=` + `?token=`) when reissuing (`apps/web/lib/auth.ts:100-108`). The endpoint honors the requested userId only if the proof validates, with a 30-day post-expiry grace (`apps/server/cmd/server/connection_token.go:15,37-47`); otherwise it silently mints a fresh identity. This is the fix for closed #77 (host impersonation via bare `?userId=`).
- Token refresh on reconnect: centrifuge `getToken` re-runs `resolveConnectionToken` (`apps/web/lib/realtime.ts:140`), so an expiring 24h token is refreshed transparently and the same userId is kept via the proof flow (closed #85).
- The chosen name is session-scoped per tab in `sessionStorage.mj_room_name` (`apps/web/app/room/[id]/client.tsx:13,159`) purely to survive the Spotify OAuth full-page redirect; it drives auto-rejoin on mount (`client.tsx:180-185`).
- Server-side, the guest's display name is copied from connect data into centrifuge `ConnInfo` (`apps/server/cmd/server/main.go:333-341`). Note: only `name` is forwarded; the `platform` field the client sends (`apps/web/lib/realtime.ts:127-128`) and parses back (`realtime.ts:77-82`) is dropped at this point, so presence platform icons never render from live presence.

## 2. Capabilities: guest vs account vs host

Server authz makes no distinction between a guest and an account user: both arrive with a non-empty `userID` (anonymous sub vs `sb:<uuid>`) when `FEATURE_ROOM_AUTH` is on. The only roles are member and host. When `FEATURE_ROOM_AUTH` is off, `userID` is empty for everyone, `HostUserID` is never set, and every RPC below is open to every connected client (v0; `hub.go:392-394`, `apps/web/lib/roomRole.ts:15-29`).

RPC-by-RPC, assuming room auth ON and a host assigned who is not the caller:

| RPC | Kind | Guest (non-host) | Host (guest or account) |
| --- | --- | --- | --- |
| `room.join` | enroll | YES; also claims host if current host is absent (`hub.go:615-624`) | YES |
| `queue.add` | mutating, member-gated | YES (`hub.go:190-201`; not in `hostOnlyMethods`) | YES |
| `queue.remove` | host-only with self exception | own tracks only, matched on server-set `AddedByUserID` (`hub.go:396-398,410-428`; closed #92) | YES (any track) |
| `queue.reorder` | host-only | NO (`hub.go:208-218,392-400`) | YES |
| `now_playing.set` | host-only | NO | YES |
| `now_playing.advance` | host-only | NO | YES |
| `playlist.import` | host-only | NO | YES |
| `radio.set` | host-only | NO | YES |
| `transport.play/pause/seek` | host-only + `FEATURE_SYNC` | NO | YES |
| `track.search` | read | YES; no membership or auth required (`hub.go:379-381`) | YES |
| `track.depth` / `track.lyrics` / `track.listenbrainz` / `track.lastfm` | read | YES | YES |
| `sync.ping` | read | YES | YES |

- A guest CAN be host: the first authenticated joiner of a fresh room becomes host regardless of whether the identity is anonymous or `sb:` (`hub.go:615-619`). Host is reclaimed lazily: on any later `room.join`, if the current host's userID has no active member in the room, the joiner takes over (`hub.go:620-624`, `IsUserIDInRoom` at `hub.go:325-344`).
- Client-side gating mirrors this with `canControl` (`apps/web/lib/roomRole.ts:15-29`; used at `client.tsx:132-136` for `TransportUI` and `QueuePanel`), comparing `localStorage.cojam_uid` to `state.hostUserId`.
- Fanout RPCs are rate-limited per userID when present, else per clientID (`hub.go:1194-1202`; closed #91), so guests are limited per connection.

## 3. Persistence

- Room state (`queue` with `addedBy` display name + server-owned `addedByUserId`, `hostUserId`, `radioEnabled`, `transport`, `version`) is write-through persisted on every mutation (`hub.go:487-525`) into Postgres in production: upsert into `rooms`, no delete path anywhere (`apps/server/internal/store/postgres.go:53-82`). A guest's queued tracks therefore outlive their tab, their token, and their identity, indefinitely.
- Rooms are never evicted from hub memory either (`hub.go:439-480`; open #118).
- Presence is centrifuge in-memory only (`ConnInfo` `{name}`), gone on disconnect. On disconnect the server drops the client's memberships and userID tracking (`apps/server/cmd/server/main.go:382-387`); the guest's tracks and `hostUserId` remain in room state.
- Browser-side guest state: `localStorage.cojam_uid`, `localStorage.cojam_token` (`apps/web/lib/auth.ts:6-7`); `sessionStorage.mj_room_name` (`client.tsx:13`); Spotify OAuth artifacts `mj_spotify_token` / `mj_spotify_verifier` / `mj_spotify_return` all in `sessionStorage` (`apps/web/lib/spotifyAuth.ts:13-15,68-76,104-105`), so a guest's Spotify connection dies with the tab.
- Nothing server-side ties a guest to their data beyond `addedByUserId` on queue rows; there is no guest profile, no room roster, no history.

## 4. Friction and failure modes

- localStorage cleared (or new browser/profile, or private browsing): `cojam_uid`/`cojam_token` are gone, the proof flow cannot run, and the endpoint silently mints a fresh identity (`connection_token.go:41-47`). Consequences: a returning host loses the room (their new userID does not match `hostUserId`, and `canControl` flips them to listener), and they lose self-serve `queue.remove` on their own tracks (`addedByUserId` mismatch, `hub.go:424`). The old attribution is orphaned forever. There is no recovery path and no UI signal that identity is browser-local.
- Host guest leaves: host handoff is lazy. It happens only inside `room.join` (`hub.go:620-624`), i.e. when someone (re)joins. Members who stay connected never re-join (the reconnect resync at `realtime.ts:162-171` only fires after a connection drop). So when a host guest closes their tab, all host-only RPCs (transport, now_playing, reorder, radio, import, remove-others) are locked for everyone remaining until somebody's connection cycles or a new person joins. No proactive handoff on disconnect exists (`main.go:382-387` only cleans membership maps).
- Name collisions: nothing prevents two guests picking the same name. Presence is deduped by name client-side (`apps/web/app/room/components/PresenceBar.tsx:13-21` and the fused chip at `client.tsx:141-146`), so two same-name guests render as one person and one count. `addedBy` is free-text client input (`hub.go:997`; capped at 300 chars by `validateImportTracks`), so display-name impersonation is trivial; only `addedByUserId` is identity-grade.
- Token endpoint failure mode: `fetchConnectionToken` returns null on any error (`apps/web/lib/auth.ts:117-131`), `resolveConnectionToken` then yields an empty token (`realtime.ts:113`), and with room auth on the server rejects the connect as Unauthorized (`main.go:355-359`). The user sees only the generic 10s join timeout/error (`realtime.ts:221-231`, `client.tsx:163-165`; closed #87). Server-down and auth-misconfigured are indistinguishable in the UI.
- Guest Spotify/Apple playback auth is per-tab sessionStorage; a guest re-auths Spotify in every new tab, and the OAuth redirect relies on `mj_room_name` to auto-rejoin.

## 5. Gaps vs accounts

- Search ranking: `track.search` `prefer` is built from persisted connected services merged with live OAuth (`apps/web/app/room/components/AddTrackForm.tsx:51,72`, `apps/web/lib/account.ts:143-150`). Persisted services load only for signed-in users (`client.tsx:80-93`); a guest gets live-tab state only, so ranking resets on every new browser/tab and never follows them.
- Cross-device identity: account users get a stable `sb:<uuid>` on any device (`main.go:348-352`); host role and own-track rights follow them. A guest's identity is localStorage-bound to one browser profile.
- Connected-services memory: `markServiceConnected` is a no-op signed out (`client.tsx:97-111`), so nothing accumulates for a guest.
- Everything else (RPC surface, host eligibility, rate limits) is identical by design; the account value proposition is durability and ranking, not capability.

## Risks

- RK1 (high): Host departure locks the room. A guest host closing their tab leaves transport/now_playing/reorder/radio/import locked for all remaining members until someone re-joins (`hub.go:620-624`, `realtime.ts:162-171`). Most likely room-death scenario for the name-only path.
- RK2 (high): Silent, permanent identity loss on localStorage clear. Orphaned `hostUserId` and `addedByUserId`, no recovery, no UI hint (`apps/web/lib/auth.ts:6-7`, `connection_token.go:41-47`).
- RK3 (medium): Presence conflation and free-text `addedBy` make same-name guests indistinguishable and display-name impersonation trivial (`PresenceBar.tsx:13-21`, `hub.go:997`). Gets worse when chat (#131) and voting (#130) land on top of display names.
- RK4 (medium): Unbounded persistence of guest-attributed data: rooms upsert-only in Postgres, never evicted in memory (`postgres.go:53-82`, #118).
- RK5 (low): Auth-misconfig and server-down are indistinguishable to the joining guest (generic 10s error), and the token endpoint fails silently by design (`auth.ts:117-131`, `main.go:355-359`).
- RK6 (low): Presence `platform` is sent by the client but dropped server-side, so platform icons never populate from presence (`main.go:333-341` vs `realtime.ts:77-82,127-128`).

## Recommendations

- R1: Proactive host handoff on host disconnect (promote the longest-present member, or unlock the room when the host leaves) instead of lazy reclaim on next `room.join`. Was not covered; filed as #139.
- R2: Guest identity durability: surface "identity is this browser only" in the join/room UI, offer an in-room account upgrade path, and decide a policy for orphaned `addedByUserId` rows. Was not covered; filed as #140. (Positioning copy itself is #127, landing page only.)
- R3: Name-collision handling: dedupe presence by clientId/userId rather than display name, and disambiguate duplicate display names (suffix) before chat (#131) and voting (#130) build on names. Was not covered; filed as #141.
- R4: Idle-room eviction, extended to Postgres row cleanup for abandoned rooms (today upsert-only). Covered by #118 (extend its acceptance to DB rows).
- R5: Document the `/api/connection-token` contract including the ownership-proof flow. Covered by #113.
- R6: Finish generic runtime flags so `roomAuthEnabled` (and thus the whole guest identity path) is not a per-flag one-off. Covered by #126.
- R7: Key future social features (voting #130, chat #131) on server identity (`addedByUserId`-style), never on display name. Covered by the spec-first acceptance of #130 and #131; flagged here so it is not lost.
- R8 (minor): Either forward `platform` in `ConnInfo` or delete the dead client plumbing. Not issue-worthy on its own; fold into R3's presence cleanup.
