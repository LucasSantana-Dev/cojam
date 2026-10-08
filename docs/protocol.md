# Room protocol v0

Transport: centrifuge (server: Go `centrifugal/centrifuge`; client: `centrifuge-js`). One centrifuge channel per room: `room:<roomId>`. All payloads JSON. Server is authoritative for queue state; clients send RPC-style commands, server publishes resulting state to the channel.

## Client → server (centrifuge RPC, method names)

| method | params | result |
|---|---|---|
| `room.join` | `{ roomId: string, name: string }` | `RoomState` |
| `queue.add` | `{ roomId, track: TrackRef }` | `RoomState` |
| `queue.remove` | `{ roomId, trackId: string }` | `RoomState` |
| `queue.reorder` | `{ roomId, trackId: string, toIndex: number }` | `RoomState` |
| `queue.vote` | `{ roomId, trackId: string }` | `RoomState` |
| `history.readd` | `{ roomId, trackId: string }` (a `history[].id`) | `RoomState` |
| `now_playing.set` | `{ roomId, trackId: string }` | `RoomState` |
| `now_playing.advance` | `{ roomId, afterId: string }` | `RoomState` |
| `track.search` | `{ query: string, prefer?: string[] }` | `SearchResult[]` |
| `track.depth` | `{ roomId, isrc: string, title: string, artist: string }` | `TrackDepth` |
| `track.lyrics` | `{ roomId, artist: string, title: string, album: string, durationMs: number }` | `LyricsResult` |
| `track.listenbrainz` | `{ roomId, isrc: string, title: string, artist: string }` | `ListenBrainzResult` |
| `track.lastfm` | `{ roomId, artist: string, title: string }` | `LastfmEnrich` |
| `playlist.import` | `{ roomId, url: string, addedBy: string, tracks?: Omit<TrackRef, 'id' \| 'addedBy'>[] }` | `RoomState` |
| `radio.set` | `{ roomId, enabled: boolean }` | `RoomState` |
| `room.set_public` | `{ roomId, public: boolean, name?: string }` | `RoomState` |
| `room.list` | `{}` | `{ rooms: PublicRoomSummary[] }` |
| `transport.play` | `{ roomId, trackId?: string, positionMs: number }` | `RoomState` |
| `transport.pause` | `{ roomId, positionMs: number }` | `RoomState` |
| `transport.seek` | `{ roomId, positionMs: number }` | `RoomState` |
| `chat.send` | `{ roomId, text: string }` (a `name` field is ignored) | `{ message: ChatMessage }` |
| `chat.history` | `{ roomId }` | `{ messages: ChatMessage[] }` |
| `chat.delete` | `{ roomId, messageId: string }` | `{ messageId: string }` |
| `room.kick` | `{ roomId, clientId: string }` | `{ clientId: string }` |
| `room.set_admin` | `{ roomId, userId: string, admin: boolean }` | `RoomState` |
| `room.claim_host` | `{ roomId }` | `RoomState` |
| `room.transfer_host` | `{ roomId, userId: string }` | `RoomState` |
| `room.rebind` | `{ roomId, proof: string }` | `RoomState` |
| `member.set_platform` | `{ roomId, platform: 'spotify' \| 'apple' \| 'youtube' }` | `{ clientId: string, platform: string }` |
| `member.platforms` | `{ roomId }` | `{ platforms: Record<clientId, platform> }` |
| `sync.ping` | `{}` | `{ serverNowMs: number }` |

`track.search` is a read (not membership-gated). The query is trimmed; empty
after trim or longer than 200 chars is rejected with a UserError (code 400)
before any upstream fanout. `prefer` lists the caller's connected
providers (`"spotify"`, `"apple"`); results playable on those providers rank first, other
providers still appear below. Unknown providers are ignored; omitting `prefer` leaves the
order unchanged. `prefer` is capped to the provider allowlist size (3); extras are
truncated.

`playlist.import` accepts an optional `tracks` array (RFC-0007). When present and
non-empty, the server skips its own playlist fetcher and enqueues the supplied
metadata after validation (max 200 tracks, field length caps, duration range,
`spotify:track:<base62>` URI shape); the web client uses this for Spotify imports,
which it fetches client-side with the user's OAuth token. When `tracks` is absent,
the server fetches `url` itself (Deezer, YouTube). Compatibility: old clients send
no `tracks` and behave as before; old servers ignore the unknown field and fetch
`url` server-side (Spotify URLs then 403 in dev mode). `playlist.import` draws from
the per-caller fanout rate limit (same bucket as `track.search` and the enrichment
reads; a rejection is the code-400 "too many requests, slow down" UserError).

`track.depth`, `track.lyrics`, `track.listenbrainz`, and `track.lastfm` are reads
(not membership-gated). Each fans out to one third-party provider and degrades to
an empty result with `source` set when its feature flag is off or the lookup
misses; a miss is logged, never an RPC error. Result shapes:

```ts
type TrackDepth = {          // source: "musicbrainz" (FEATURE_TRACK_DEPTH, default on)
  credits: { role: string; name: string }[];
  releaseYear?: number;
  label?: string;
  tags: string[];
  source: string;
};

type LyricsResult = {        // source: "lrclib" (FEATURE_LYRICS, default on)
  synced: { timeMs: number; text: string }[];
  plain: string;
  source: string;
};

type ListenBrainzResult = {  // source: "listenbrainz" (FEATURE_LISTENBRAINZ, default off)
  mbid?: string;
  tags: string[];
  count?: number;            // listen count, when available
  source: string;
};

type LastfmEnrich = {        // source: "lastfm" (FEATURE_LASTFM_ENRICH + LASTFM_API_KEY, default off)
  playcount?: number;
  listeners?: number;
  tags: string[];
  source: string;
};
```

`radio.set` toggles `radioEnabled` (host only). `radioAvailable` tells clients
whether the server can refill at all; the toggle only stores intent. When the queue runs dry on
`now_playing.advance` with radio on, the server refills the queue asynchronously
from a similar-tracks provider (Last.fm, `FEATURE_RADIO` + `LASTFM_API_KEY`)
seeded by the last played track (`history[0]`). The refill fanout is deliberately not
rate-limited: it fires at most once per advance that actually empties the queue
(the refill re-checks state and no-ops otherwise), and the trigger RPC is
host-only, so per-caller spam cannot multiply upstream calls.

`room.set_public` opts a room into the public directory (member + host only,
`FEATURE_PUBLIC_ROOMS`, default off). `public` persists on the room until the
host revokes it; the default is private (zero value), so existing rooms are
unaffected. `name` is an optional plain-text room label: trimmed, capped at 60
chars (longer is rejected with a UserError, code 400), empty after trim clears
the label, and an absent key leaves it untouched. The mutation bumps
`RoomState.version` like every other mutation. A label matching the server's
blocklist of sexual, slur and minor-sexualizing terms (#259) is rejected with a
UserError (code 400, message `room name not allowed`); going public with an
already stored blocked label is rejected the same way, and `room.list` skips any
room whose label matches.

`room.list` is the directory read: any connected client may call it (not
membership-gated), rate-limited per caller (burst 5, one token per 2s; a
rejection is the same code-400 UserError as fanout rejections). It returns
only rooms currently loaded in the hub with `public == true`, never creates or
loads rooms, skips dead rooms (0 members AND an empty queue), sorts by
`memberCount` descending (`roomId` ascending for stability), and caps at 100
entries (search and sort run client-side, #306). `memberCount` counts connected members (join + subscribe enrollment),
so one person in two tabs counts twice. Only the summary fields are exposed:
queue contents, host id, transport, and vote data stay room-channel-only. When
`FEATURE_PUBLIC_ROOMS` is off, both RPCs reply `ErrorMethodNotFound`.

```ts
type PublicRoomSummary = {
  roomId: string;
  name?: string;          // present only if the host set one
  memberCount: number;    // connected members
  nowPlaying?: { title: string; artist: string };
  kind: 'audio' | 'video'; // now-playing track kind; 'audio' when nothing plays
  lastActiveMs: number;    // room's last activity, unix ms (server clock)
};
```

`transport.play` / `transport.pause` / `transport.seek` exist only when
`FEATURE_SYNC` is on; otherwise the server replies `ErrorMethodNotFound`.
`positionMs` is clamped to `>= 0`. `transport.play` optionally switches
`nowPlayingId` first. All three stamp `transport.updatedAtServerMs` server-side
and publish the full `RoomState`. `sync.ping` is a read returning the server
clock (unix ms) for client offset estimation.

Transport RPCs draw from their own per-caller limiter (burst 20, one token per
250ms), separate from the fanout limiter: scrubbing is bursty and touches no
third-party API.

Video co-watch (E1, #258) is gated by its own flag, `FEATURE_VIDEO` on the
server and `COJAM_FEATURE_VIDEO` on the web runtime (default off, independent
of `FEATURE_SYNC`; the transport controls still need sync). A track is a video
track when `TrackRef.kind === "video"`; the web client sets it when a YouTube
link is added from the manual form with the flag on. While the now-playing
track is `kind: "video"` and `transport.state === "playing"`, the server
republishes the room state every 10s with `version` bumped and `transport`
unchanged, so clients that missed a publication converge on the next beat. The
ticker stops on pause, track end, a non-video track, an empty room and room
eviction. No video bytes cross the server: each client renders its own IFrame.

`chat.send` / `chat.history` (F8) exist only when `FEATURE_ROOM_CHAT` is on
(default off); otherwise the server replies `ErrorMethodNotFound`. Chat is
ephemeral: an in-memory per-room ring of the last 50 messages, never part of
`RoomState` (no `version` bump, no full-state fan-out) and never persisted (no
`store.Save`, restart = empty chat). `chat.send` trims `text` (1..300 chars,
else a 400 UserError), caps `name` at 60 chars, stamps `id`, `userId` (from
the connection identity, never params), and `sentAtServerMs`, appends to the
ring, and publishes a `chat.message` publication on the room channel; the RPC
result is just the stamped message (authoritative delivery is the
publication, sender included). `chat.history` returns the ring oldest-first
for late joiners/rejoins. `chat.send` is rate-limited per caller (burst 5,
one token per 2s; "too many requests, slow down"); `chat.history` is not.

Host moderation (#181): `chat.delete` tombstones a ring entry — the slot is
kept (history is never rewritten, so late joiners see a stable order) but the
text is redacted server-side (`deleted: true`, `text: ""`), so a history
refetch cannot resurrect it; a `chat.delete` publication tells connected
clients to drop the line by id. Deleting an unknown id is a 400 UserError.
`room.kick` drops the target connection's membership in the room and closes
that connection with the terminal disconnect code 4500 ("removed by host";
centrifuge clients do not reconnect after terminal codes), so the kicked
client stops and shows an explicit "removed by host" state; remaining members
see the departure through the usual presence leave event. Both are
membership-gated like the other mutating RPCs and host-only, but the host
check happens in dispatch: a non-host attempt is rejected with a UserError
(code 400), not `ErrorPermissionDenied`. Both draw from the same per-caller
rate limit as `chat.send`. `chat.delete` shares the `FEATURE_ROOM_CHAT` gate
(`ErrorMethodNotFound` when chat is off); `room.kick` has no feature flag.

Guest-to-account upgrade (#172): `room.rebind` moves a guest's attribution in
the current room from their anonymous sub to their signed-in `sb:<uuid>`
identity, so a guest who signs in keeps what they already did. The payload
carries the room and `proof`, the stored anonymous connection JWT, and no
identity field: the server verifies the signature with the same grace as the
connection-token refresh (30 days) and reads the old identity from the
verified `sub`, so a client can only ever claim the guest identity it
actually held. Guards, each rejected with a UserError (code 400): the caller
must be signed in (`sb:` identity), the proof must verify, the account must
not already be in the room on another connection (collision message: "This
account is already in this room from another tab or device. Close it and
retry."), and the sub must be unconsumed. One mutation bumps `version` once:
track ownership (`addedByUserId`) moves to the account, the host role moves
if the guest held it, voter keys rewrite from `user:<anonSub>` to
`user:sb:<uuid>` (deduped, so no double vote), and join-time seniority
transfers so longest-present host promotion keeps the guest's standing (the
transfer runs inside the same serialized mutation, before the state
publishes). `addedBy` display strings stay untouched. A successful rebind
consumes the sub: it is recorded in `rebound_subs`, later rebinds presenting
it are rejected ("this guest identity was already upgraded"), and
`/api/connection-token` refuses to reissue it. The in-memory fallback (no
`DATABASE_URL`) is dev/test-only: production must run with Postgres or the
single-use guarantee does not survive restarts. The burn claim lands
immediately after the mutation commits, with a pre-mutation check rejecting
already-consumed subs.
The rebound sub's remaining connections in the room are force-disconnected
via the `room.kick` mechanism so a still-open anonymous tab cannot keep
accumulating attribution under the dead sub. The RPC exists only when
`FEATURE_ROOM_AUTH` is on; otherwise the server replies
`ErrorMethodNotFound`. The web client attempts the rebind on every room join
while an unconsumed proof token exists, discards the token only after a
post-rebind `room.state` publication shows the account identity (or when the
server confirms the sub is dead), and degrades proof-verification failures
to a soft notice while sign-in proceeds.

The server also publishes **system messages** (#205): `chat.message`
publications with `kind: "system"` and no member identity (`name`/`userId`
empty) — `Now playing: <title> — <artist>` when `now_playing.advance` actually
moves to a next track (not on the idempotent no-op, not when the queue ends),
and `<name> joined` / `<name> left` on membership enrollment/disconnect (the
name is the connect-time display name, falling back to `Someone`). System
messages share the ring and the ephemeral guarantees (no `version` bump, no
`store.Save`) and never draw from the chat rate limiter — they are
server-generated, bounded by the ring and by the events themselves. The first
join of a brand-new room is silent: the room exists only once the `room.join`
RPC creates it. Clients render system rows distinctly (mono, muted, no
avatar).


### Roles & authorization (RFC-0005, behind `FEATURE_ROOM_AUTH`)

When `FEATURE_ROOM_AUTH` is on, connections present a server-signed token (anonymous stable
`sub`) and the server records a room **host** (the first authenticated joiner; reclaimed if the
host leaves). Host-only RPCs are rejected with `ErrorPermissionDenied` for non-hosts — except the
moderation RPCs (`chat.delete`, `room.kick`, #181), which reject non-hosts with a client-visible
UserError (code 400) instead; the server
is authoritative (the web UI also hides these controls for listeners, but that is convenience
only). The host check reads the room's persisted state, loading it from the store when it is not
in memory (e.g. after a restart), and fails closed: with the flag on, a room with no host bound
yet rejects host-only RPCs until a `room.join` claims it. When the flag is off, every member has
equal rights (v0), unchanged; a host bound by a signed-in account (`FEATURE_SUPABASE_AUTH`) is
still enforced.

| RPC | Who may call (flag on) |
|---|---|
| `queue.add` | any member |
| `queue.vote` | any member (guests included) |
| `chat.send`, `chat.history` | any member |
| `chat.delete` | host or owner (others get a code-400 UserError) |
| `room.kick` | host or owner (others get a code-400 UserError); the owner cannot be kicked |
| `room.set_admin` | host or owner; cannot target the owner or yourself; max 20 admins |
| `room.transfer_host` | host or owner; target must be a member present now |
| `room.claim_host` | owner only; takes the host role back from a present host |
| `room.rebind` | any member; caller must be signed in (`sb:` identity) |
| `room.join`, `sync.ping`, reads | any caller |
| `now_playing.set` / `now_playing.advance` | host, owner or admin |
| `queue.reorder` | host, owner or admin |
| `history.readd` | host, owner or admin |
| `queue.remove` | host, owner, admin, or the member who queued the track (`addedByUserId`) |
| `radio.set`, `playlist.import` | host, owner or admin |
| `room.set_public` | host or owner (not admins) |
| `transport.play` / `transport.pause` / `transport.seek` | host, owner or admin |

`queue.remove` ownership: the server stamps `TrackRef.addedByUserId` from the connection identity
on `queue.add` and `playlist.import` (a client-supplied value is overwritten). Tracks queued before
this existed (or while the flag is off) carry no owner and stay host-only.

Attribution (#165): the server also stamps `TrackRef.addedBy` (the display name) from the name the
connection presented at connect time (centrifuge ConnInfo), on both `queue.add` (overriding
`track.addedBy`) and `playlist.import` (overriding the `addedBy` param); a crafted value naming
another member never reaches the room state. When the connection presented no name (room auth off
and no connect-data name), the validated client value stands (v0).

Timestamps: the server stamps `TrackRef.addedAt` (unix ms) when a track enters the queue and
`RoomState.createdAt` (unix ms) at room creation; client-supplied values are overwritten. Rooms
and tracks persisted before this existed carry no timestamp (absent on the wire); clients must
tolerate that and stay silent rather than showing a fake time.

`queue.vote` (F4, behind `FEATURE_QUEUE_VOTING`, default off; `ErrorMethodNotFound` when off)
toggles the caller's upvote on a queued track: absent votes on, present votes off, one vote per
voter per track. The server stamps the voter key from the connection identity (`user:<userID>`
when authenticated, else `client:<clientID>`); clients never send who they are. Votes live in a
separate `RoomState.votes` map (track ID to voter keys), not on `TrackRef`, are pruned when a
track leaves the queue, and are capped at 200 voters per track. Guest votes are ephemeral: a
disconnect prunes that connection's `client:<clientID>` keys from every room it joined (with a
`version` bump + publish), so a reconnecting guest gets a fresh clientID and cannot double-vote;
authenticated `user:<userID>` votes persist across reconnects. Each toggle bumps `version` and
publishes the full state; a dedicated per-caller rate limit (10 burst, one token per 2s) throttles
toggle wars. Voting is member-gated but never host-only, and counts are a reorder suggestion for
the host, not an automatic reorder: the web client renders counts plus a listeners-pick marker and
the host acts on them with `queue.reorder`.

## Server → channel publications

Every accepted mutation publishes the full `RoomState` (v0 keeps it simple; deltas later if payloads grow):

```json
{ "type": "room.state", "state": RoomState }
```

Accepted chat messages publish a per-message shape on the same channel (F8;
distinguished by `type`, no version guard since chat is not `RoomState`):

```json
{ "type": "chat.message", "message": ChatMessage }
```

A host's `chat.delete` publishes the tombstone event (#181); clients drop the
line by id and never render history entries with `deleted: true`:

```json
{ "type": "chat.delete", "messageId": "..." }
```

Listening service ("Ouvir no"): ConnInfo is fixed per connection and a reconnect would run the host handoff, so a member changes the platform shown for them with `member.set_platform` (membership-gated, value must be spotify, apple or youtube, shares the chat rate limit). The server keeps it per connection, drops it on disconnect, and publishes on the room channel (no version guard, not `RoomState`):

```json
{ "type": "member.platform", "clientId": "...", "platform": "youtube" }
```

Clients overlay it on the presence entry with that `clientId` (it wins over the ConnInfo platform). A late joiner seeds the overlay with `member.platforms` (membership-gated read, the current overrides of the room's members).

Presence: centrifuge native presence on the channel (join/leave events + presence query), no custom messages. Entries are keyed per connection (clientId, plus userId when authenticated: centrifuge's native `user` field on each presence entry, no new field), never on display name: two connections that picked the same name are two distinct entries and count as two listeners. Each entry's ConnInfo is `{"name": string, "platform"?: "spotify"|"apple"|"youtube"}`: the name and playback platform the client presented at connect; the server trims the name and caps it at 40 runes, and drops unrecognized platform values, so presence only carries platforms the UI can render. Display concerns stay client-side: colliding names get a deterministic suffix ("Alice", "Alice (2)") derived from the member list (sorted by clientId), recomputed on every membership change; presence is centrifuge-level, so none of this touches `RoomState` or `Version`. Vote keys in `RoomState.votes` are `user:<userId>` (authenticated) or `client:<clientId>` (no room auth); the web client resolves a voter to a member by matching that id against the presence entry's `user` or `client`, and renders a voter who has left the room as anonymous.

## Accounts (Supabase Auth, behind `FEATURE_SUPABASE_AUTH`)

Accounts are optional; guests use rooms exactly as before. The web app signs users in with
Supabase (magic link) and presents the Supabase access token as the centrifuge connection
token. The server validates it (ES256 or RS256 via the project JWKS from `SUPABASE_URL`, falling back to
HS256 with the legacy project JWT secret; audience `authenticated`) and
sets the identity to `sb:<user-uuid>`; anything that does not validate falls through to the
anonymous room-auth path, then to v0 allow-all. Token precedence on connect:
Supabase account token → anonymous room-auth token → none.

Account data lives in the Supabase project, written client-direct with row-level security
(owner-only): `public.profiles` (display name) and `public.connected_services` (the fact
that Spotify/Apple is connected; OAuth tokens never leave the client). Persisted connected
services feed the `prefer` parameter of `track.search` on any device.

## Connection token endpoint (`POST /api/connection-token`)

HTTP endpoint on the Go server (`cmd/server/connection_token.go`) that mints the
anonymous connection token used above. Returns `501 {"error": "connection auth not enabled"}`
when `FEATURE_ROOM_AUTH` is off, and `429` when the caller's IP exceeds its
budget (30 burst, one token per second; `CONNECTION_TOKEN_RATE_BURST` overrides
the burst; the IP is resolved as for the other public endpoints, from
`CF-Connecting-IP` behind the proxy chain).

Body fields (both optional), form-encoded (`application/x-www-form-urlencoded`,
what the web client sends: a CORS simple request) or JSON:

- `userId`: a previous anonymous identity the caller wants to keep.
- `token`: the previous connection JWT, proving ownership of that `userId`.
  May instead be sent as an `Authorization` header with the `Bearer` scheme.

Deprecated: `GET /api/connection-token?userId=&token=` is still honored for one
release so older clients keep their identity, and logs a
`connection_token_query_deprecated` warning (without the values). It puts the
proof in the URL, so it will be removed. Deploy order: server first. The web
client falls back to the GET form once when a POST gets 405 or 404, so a web
deploy that lands before the server keeps working.

Response `200`: `{ "token": string, "userId": string }`, where `token` is an HS256
JWT (secret `ROOM_AUTH_SECRET`, claims `{sub, exp, iat}`, TTL 24h) with `sub` = `userId`.

Ownership-proof reissue: the server honors `userId` only when `token` validates
(correct signature, `sub` matches `userId`, expired no more than 30 days ago; the
grace lets a returning user keep their identity across longer absences without
widening the live-token window). Without proof the param is ignored and a fresh
identity is minted; otherwise anyone could mint a token for any userID (for
example a room host's, read from presence) and be treated as that user. The
fail-safe default is always a fresh identity, never an error: clients adopt
whatever `userId` comes back. A sub consumed by a `room.rebind` upgrade
(#172) is dead: refresh for it is rejected the same way and a fresh identity
is minted. The web client (`apps/web/lib/auth.ts`) persists
both values in localStorage and presents them on the next fetch.

## Web runtime config (`GET /env.js`)

The web image must be host-agnostic, but `NEXT_PUBLIC_*` is inlined at build
time. The web app therefore serves `app/env.js/route.ts` per request
(`force-dynamic`, `cache-control: no-store`, content type
`application/javascript`), loaded via a `beforeInteractive` `<Script>` so it runs
before the app:

```js
window.__COJAM_ENV__ = { ... };
```

Fields (runtime env var in parentheses):

- `wsUrl` (`COJAM_WS_URL`), `spotifyClientId` (`COJAM_SPOTIFY_CLIENT_ID`): always
  emitted, empty string when unset.
- `features`: a map of feature-flag overrides, one key per flag defined in
  `apps/web/lib/features.ts` (`youtube`, `spotify`, `apple`, `presence`,
  `trackDepth`, `lyrics`, `listenBrainz`, `lastfmEnrich`, `sync`, `roomAuth`,
  `queueVoting`, `roomChat`, `publicRooms`). Each flag's runtime var is
  `COJAM_FEATURE_<SCREAMING_SNAKE>` (the mapping is the `FEATURE_ENV_VARS`
  const). A key is emitted only when its variable is explicitly set, so an
  unset runtime value falls back to the build-time `NEXT_PUBLIC_FEATURE_*`
  flag instead of forcing it off; the whole map is omitted when no flag is
  set. Runtime parsing is strict: only the exact string `true` enables a flag,
  any other set value disables it.
- `supabaseUrl` + `supabaseAnonKey` (`COJAM_SUPABASE_URL` +
  `COJAM_SUPABASE_ANON_KEY`): emitted only as a pair; emitting just one would mix
  the runtime project with the build-time fallback of the other, pointing the
  client at two different Supabase projects.

Example: a host with `COJAM_FEATURE_SYNC=true` and `COJAM_FEATURE_LYRICS=false`
set serves `window.__COJAM_ENV__ = { wsUrl: ..., spotifyClientId: ...,
features: { sync: true, lyrics: false } }`, and every other flag keeps its
build-time value.

`apps/web/lib/runtimeEnv.ts` consumes the contract: `getRuntimeEnv()` reads
`window.__COJAM_ENV__` (undefined on the server or before `/env.js` has run),
`pickEnv()` resolves a scalar runtime first, then the build-time
`NEXT_PUBLIC_*`, then a default (blank or whitespace-only values count as
unset), and `resolveRuntimeFeatures()` merges the runtime `features` map over
the build-time flags (a key present in the map wins, an absent key keeps the
build-time value). Client components read flags through the hydration-safe
`useRuntimeFeatures()` hook; reading the module-level `features` const in
render misses runtime overrides.

## Types

```ts
type TrackRef = {
  id: string;          // server-assigned queue entry id (uuid)
  title: string;
  artist: string;
  durationMs?: number;
  isrc?: string;
  sources: {           // per-platform resolution, filled by matching
    youtube?: { videoId: string; confidence: number };
    apple?: { songId: string; confidence: number };
    spotify?: { trackUri: string; confidence: number };
  };
  addedBy: string;     // display name; server-stamped from the connection's connect-time name when one was recorded (client value overridden then)
  addedByUserId?: string; // authenticated userID of the adder, server-stamped
  addedAt?: number;    // unix ms when queued, server-stamped (absent on older tracks)
  artworkUrl?: string; // album art, client-supplied at add time (server validates https, ≤512 chars)
  kind?: 'audio' | 'video'; // render as audio or video (#258); absent = audio. Unknown values rejected at add.
};

type HistoryEntry = {      // a track that finished or was skipped (list uses id, title, artist, artworkUrl, playedAt, addedBy)
  id: string;               // the id the track had in the queue
  title: string;
  artist: string;
  artworkUrl?: string;
  addedBy: string;
  addedByUserId?: string;
  playedAt?: number;        // unix ms when it left now-playing, server-stamped (absent on entries migrated from the old shape)
  durationMs?: number;      // the fields below are kept only so history.readd can copy the track
  isrc?: string;
  kind?: 'audio' | 'video';
  sources: { youtube?: { videoId: string; confidence: number }; apple?: { songId: string; confidence: number }; spotify?: { trackUri: string; confidence: number } };
};

type RoomState = {
  roomId: string;
  queue: TrackRef[];        // ordered; head = now playing, the rest upcoming. Played tracks are not here.
  nowPlayingId?: string;    // queue entry id
  history?: HistoryEntry[]; // played or skipped tracks, newest first, capped at 50; absent when empty. Votes and reorders never touch it.
  hostUserId?: string;      // userID of the room host (RFC-0005; empty when room auth is off)
  ownerUserId?: string;     // room creator: always reclaims host on join, cannot be kicked or demoted (absent on older rooms)
  admins?: string[];        // userIDs with full queue and transport control, set by room.set_admin
  radioEnabled: boolean;    // refill the queue with similar tracks when it runs dry
  radioAvailable?: boolean; // server capability, stamped on every state, never persisted: false = radio cannot work here (no FEATURE_RADIO / LASTFM_API_KEY), hide or disable the toggle. Absent on older servers.
  version: number;          // monotonic, bumps per mutation; clients drop stale
  transport?: TransportState; // shared play/pause/seek position (FEATURE_SYNC)
  createdAt?: number;       // unix ms at room creation, server-stamped (absent on older rooms)
  votes?: { [trackId: string]: string[] }; // server-stamped voter keys per track (FEATURE_QUEUE_VOTING)
  public?: boolean;         // directory opt-in (FEATURE_PUBLIC_ROOMS); absent = private
  name?: string;            // optional host-set room label shown in the directory
};

type TransportState = {
  state: 'playing' | 'paused' | 'stopped';
  positionMs: number;
  updatedAtServerMs: number; // server clock (unix ms) at last transport mutation
};

type ChatMessage = {       // F8: ephemeral, in-memory only; never in RoomState
  id: string;              // server-assigned uuid
  roomId: string;
  name: string;            // sender display name: the connection's connect-time name ("Listener" when none); any name in the payload is ignored
  userId?: string;         // server-stamped connection identity; empty when room auth is off
  text: string;            // trimmed, 1..300 chars; redacted ("") once deleted
  kind?: 'system';         // #205: server announcement (advance, join/leave); absent on user messages
  sentAtServerMs: number;  // server clock (unix ms)
  deleted?: boolean;       // host tombstone (chat.delete, #181); clients must not render it
};
```

Reconnect: centrifuge recovery + client re-issues `room.join` on reconnect; server replies with current `RoomState`; client replaces local state if `version` is newer.

## Method Details

- **History**: every path that changes `nowPlayingId` (`now_playing.advance`, `now_playing.set`, `queue.remove` of the playing track) moves the outgoing track out of `queue` into the front of `history` (capped at 50, oldest dropped) and keeps the new playing track at `queue[0]`. The sourceless auto skip is the exception: a track that never played is dropped from the queue without entering `history`, and a system chat line says why. Votes on a track are dropped when it moves to history. A played track therefore cannot come back through a vote, a reorder or a play jump. Rooms persisted before `history` existed (played tracks sitting before `nowPlayingId`, or the whole queue when nothing plays) are migrated on load: those tracks move to `history` in played order (newest first), with no `playedAt`.
- **`history.readd`**: Queue a played track again. The server copies the history entry (title, artist, sources and so on; nothing is taken from the client) to the end of `queue` as a **new** entry with a new `id`, attributed to the caller. The history entry stays and the old queue id is never resurrected. Unknown `trackId` is a user error. Subject to the queue size cap. Host, owner or admin only.
- **`queue.reorder`**: Move a queued track to a new position. Index is clamped to `[0, len-1]`, except that the playing track stays at index 0: it cannot be moved and an index below 1 clamps to 1 while something plays. Idempotent: re-ordering to the same position is a no-op. Does not change `nowPlayingId`.
- **`now_playing.advance`**: Advance to the next track after the one specified by `afterId`. IDEMPOTENT: if `nowPlayingId != afterId`, it's a no-op (another client already advanced). The finished track moves to `history`. If nothing is left in the queue, clears `nowPlayingId` (queue finished). Used by clients to auto-advance when the current track ends.

## Authorization

Mutating RPCs (`history.readd`, `queue.add`, `queue.remove`, `queue.reorder`, `queue.vote`, `now_playing.set`, `now_playing.advance`, `playlist.import`, `radio.set`, `room.set_public`, `room.set_admin`, `room.transfer_host`, `room.claim_host`, `room.kick`, `room.rebind`, `transport.play`, `transport.pause`, `transport.seek`) and the chat RPCs (`chat.send`, `chat.history`, `chat.delete`, and `member.set_platform` / `member.platforms`, which are membership-gated but never mutate `RoomState`) require the caller to be a **member** of the target room. A client becomes a member by subscribing to the room's `room:<id>` channel or by calling `room.join`; membership is dropped on disconnect. Subscribing is the reconnect-safe path (centrifuge re-subscribes automatically). A non-member mutating RPC is rejected with `ErrorPermissionDenied` before dispatch. `room.join` enrolls and is always allowed. This prevents an unauthenticated client from mutating an arbitrary room by guessing its id. Enforced at the transport boundary (where the client id is known); `HandleRPC` stays transport-independent.

### Room ids and room creation

A room id must match `^[0-9A-Z]{1,12}$`: the 12 uppercase base36 chars the web generator mints (`apps/web/lib/roomId.ts`), plus the shorter legacy ids (up to 6 chars) of the pre-#180 generator. Any RPC whose payload carries a malformed `roomId` is rejected at the transport boundary with a code-400 error (`invalid room id`) before enrollment or dispatch, and a subscription is accepted only for a `room:<id>` channel with a valid id (every other channel is refused with `ErrorPermissionDenied`). Ids are case-sensitive and never normalized, so lowercase ids are rejected rather than mapped.

`room.join` draws from a per-caller rate limit (10 burst, one token per 2s). Creating a room draws from a separate budget (10 burst, one token per minute; `ROOM_CREATE_RATE_BURST` overrides the burst), charged both per caller and per client IP (the IP of the websocket upgrade, resolved like the HTTP limiters: IPv4 per address, IPv6 per /64); a creation is denied when either bucket is empty, and a denial charges neither. It is charged only when the target room exists neither in memory nor in the store, so joining an existing room never spends it. Both reject with a code-400 UserError. The caller key is the same as the other per-caller limits (`user:<userID>`, else `client:<clientID>`).

State-fanout mutations (`history.readd`, `queue.add`, `queue.remove`, `queue.reorder`, `now_playing.set`, `now_playing.advance`, `radio.set`, `room.set_public`, `room.set_admin`, `room.transfer_host`) share one per-caller bucket (20 burst, one token per second), since every accepted call republishes the full `RoomState`. `queue.vote`, `transport.*`, the chat and moderation RPCs, and `playlist.import` keep their own buckets.

### Trust model (#180)

Room access is a **link capability**: subscribing to `room:<id>` *is* the access grant — there is deliberately no separate join-approval step. Mutation rights follow membership (subscribe or `room.join`), so anyone holding the link can read state, read chat history, and mutate the room. This is the product: share-a-link must keep working for guests with no account, and public rooms (`FEATURE_PUBLIC_ROOMS`) are listable and joinable by design.

Consequences of that decision:

- The privacy boundary of a **private** room is the unguessability of its room ID, not a server-side access check. Room IDs are generated client-side with crypto entropy (`crypto.getRandomValues`, 12 uppercase base36 chars ≈ 62 bits, `apps/web/lib/roomId.ts`). Room IDs minted by the pre-#180 generator (up to 6 chars, `Math.random`) remain valid for existing links but must be treated as guessable. See "Room ids and room creation" for the accepted format.
- Subscribing alone is sufficient for mutation rights *by decision* — the membership gate exists to bind RPCs to a room-scoped subscription (and to reconnect survival), not to keep link-holders out.
- Opting into the public directory (`room.set_public`) trades exactly this obscurity for discoverability; `room.list` exposes only summary fields.

As an adoption signal for link sharing, the server emits a structured log (`room_first_non_creator_member`) and the `music_jam_rooms_shared_total` counter the first time a room gains a second concurrent member — its first non-creator member. The flag lives on the in-memory room instance, so an evicted-and-reloaded room may emit again.

Rules: state carries metadata only, never audio. Each client plays the head track through its own platform SDK on explicit user gesture.


## Host grace, owner and admins

- The room creator is stored as `ownerUserId`. On `room.join` the owner takes the host role back only when the host is absent (including during the post-restart window); from a present host the owner takes it with `room.claim_host`, so a deliberate transfer survives a refresh.
- A disconnected host keeps the role for 60 s (`DefaultHostGrace`); if the same user rejoins the
  promotion is cancelled. During a server shutdown no host is promoted. For the same period after a
  restart, a persisted host that has not reconnected yet cannot be displaced by a first joiner.
- Admins can run every queue and transport RPC, but not kick, delete chat, set_public, set_admin or
  transfer_host.
- The server skips a now-playing track that has no source once a lookup ran in this process and cleanly
  missed, or when no matcher is configured at all (`auto_skip_sourceless`). A lookup that errored never
  triggers a skip, and a track loaded from storage is looked up once before it can be judged. The skip
  never triggers a radio refill, a refill seeds only from the last playable track, and refills are capped
  at one per room per 30 s.
