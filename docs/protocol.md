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
| `chat.send` | `{ roomId, text: string, name: string }` | `{ message: ChatMessage }` |
| `chat.history` | `{ roomId }` | `{ messages: ChatMessage[] }` |
| `sync.ping` | `{}` | `{ serverNowMs: number }` |

`track.search` is a read (not membership-gated). `prefer` lists the caller's connected
providers (`"spotify"`, `"apple"`); results playable on those providers rank first, other
providers still appear below. Unknown providers are ignored; omitting `prefer` leaves the
order unchanged.

`playlist.import` accepts an optional `tracks` array (RFC-0007). When present and
non-empty, the server skips its own playlist fetcher and enqueues the supplied
metadata after validation (max 200 tracks, field length caps, duration range,
`spotify:track:<base62>` URI shape); the web client uses this for Spotify imports,
which it fetches client-side with the user's OAuth token. When `tracks` is absent,
the server fetches `url` itself (Deezer, YouTube). Compatibility: old clients send
no `tracks` and behave as before; old servers ignore the unknown field and fetch
`url` server-side (Spotify URLs then 403 in dev mode).

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

`radio.set` toggles `radioEnabled` (host only). When the queue runs dry on
`now_playing.advance` with radio on, the server refills the queue asynchronously
from a similar-tracks provider (Last.fm, `FEATURE_RADIO` + `LASTFM_API_KEY`)
seeded by the last queued track.

`room.set_public` opts a room into the public directory (member + host only,
`FEATURE_PUBLIC_ROOMS`, default off). `public` persists on the room until the
host revokes it; the default is private (zero value), so existing rooms are
unaffected. `name` is an optional plain-text room label: trimmed, capped at 60
chars (longer is rejected with a UserError, code 400), empty after trim clears
the label, and an absent key leaves it untouched. The mutation bumps
`RoomState.version` like every other mutation.

`room.list` is the directory read: any connected client may call it (not
membership-gated), rate-limited per caller (burst 5, one token per 2s; a
rejection is the same code-400 UserError as fanout rejections). It returns
only rooms currently loaded in the hub with `public == true`, never creates or
loads rooms, skips dead rooms (0 members AND an empty queue), sorts by
`memberCount` descending (`roomId` ascending for stability), and caps at 20
entries. `memberCount` counts connected members (join + subscribe enrollment),
so one person in two tabs counts twice. Only the summary fields are exposed:
queue contents, host id, transport, and vote data stay room-channel-only. When
`FEATURE_PUBLIC_ROOMS` is off, both RPCs reply `ErrorMethodNotFound`.

```ts
type PublicRoomSummary = {
  roomId: string;
  name?: string;          // present only if the host set one
  memberCount: number;    // connected members
  nowPlaying?: { title: string; artist: string };
};
```

`transport.play` / `transport.pause` / `transport.seek` exist only when
`FEATURE_SYNC` is on; otherwise the server replies `ErrorMethodNotFound`.
`positionMs` is clamped to `>= 0`. `transport.play` optionally switches
`nowPlayingId` first. All three stamp `transport.updatedAtServerMs` server-side
and publish the full `RoomState`. `sync.ping` is a read returning the server
clock (unix ms) for client offset estimation.

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

### Roles & authorization (RFC-0005, behind `FEATURE_ROOM_AUTH`)

When `FEATURE_ROOM_AUTH` is on, connections present a server-signed token (anonymous stable
`sub`) and the server records a room **host** (the first authenticated joiner; reclaimed if the
host leaves). Host-only RPCs are rejected with `ErrorPermissionDenied` for non-hosts; the server
is authoritative (the web UI also hides these controls for listeners, but that is convenience
only). When the flag is off, every member has equal rights (v0), unchanged.

| RPC | Who may call (flag on) |
|---|---|
| `queue.add` | any member |
| `queue.vote` | any member (guests included) |
| `chat.send`, `chat.history` | any member |
| `room.join`, `sync.ping`, reads | any caller |
| `now_playing.set` / `now_playing.advance` | host only |
| `queue.reorder` | host only |
| `queue.remove` | host, or the member who queued the track (`addedByUserId`) |
| `radio.set`, `playlist.import` | host only |
| `room.set_public` | host only |
| `transport.play` / `transport.pause` / `transport.seek` | host only |

`queue.remove` ownership: the server stamps `TrackRef.addedByUserId` from the connection identity
on `queue.add` and `playlist.import` (a client-supplied value is overwritten). Tracks queued before
this existed (or while the flag is off) carry no owner and stay host-only.

Timestamps: the server stamps `TrackRef.addedAt` (unix ms) when a track enters the queue and
`RoomState.createdAt` (unix ms) at room creation; client-supplied values are overwritten. Rooms
and tracks persisted before this existed carry no timestamp (absent on the wire); clients must
tolerate that and stay silent rather than showing a fake time.

`queue.vote` (F4, behind `FEATURE_QUEUE_VOTING`, default off; `ErrorMethodNotFound` when off)
toggles the caller's upvote on a queued track: absent votes on, present votes off, one vote per
voter per track. The server stamps the voter key from the connection identity (`user:<userID>`
when authenticated, else `client:<clientID>`); clients never send who they are. Votes live in a
separate `RoomState.votes` map (track ID to voter keys), not on `TrackRef`, are pruned when a
track leaves the queue, and are capped at 200 voters per track. Each toggle bumps `version` and
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

Presence: centrifuge native presence on the channel (join/leave events + presence query), no custom messages.

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

## Connection token endpoint (`GET /api/connection-token`)

HTTP endpoint on the Go server (`cmd/server/connection_token.go`) that mints the
anonymous connection token used above. Returns `501 {"error": "connection auth not enabled"}`
when `FEATURE_ROOM_AUTH` is off.

Query params (both optional):

- `userId`: a previous anonymous identity the caller wants to keep.
- `token`: the previous connection JWT, proving ownership of that `userId`.

Response `200`: `{ "token": string, "userId": string }`, where `token` is an HS256
JWT (secret `ROOM_AUTH_SECRET`, claims `{sub, exp, iat}`, TTL 24h) with `sub` = `userId`.

Ownership-proof reissue: the server honors `userId` only when `token` validates
(correct signature, `sub` matches `userId`, expired no more than 30 days ago; the
grace lets a returning user keep their identity across longer absences without
widening the live-token window). Without proof the param is ignored and a fresh
identity is minted; otherwise anyone could mint a token for any userID (for
example a room host's, read from presence) and be treated as that user. The
fail-safe default is always a fresh identity, never an error: clients adopt
whatever `userId` comes back. The web client (`apps/web/lib/auth.ts`) persists
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
- `spotifyEnabled` (`COJAM_FEATURE_SPOTIFY`), `roomAuthEnabled`
  (`COJAM_FEATURE_ROOM_AUTH`), `queueVotingEnabled` (`COJAM_FEATURE_QUEUE_VOTING`):
  emitted only when the variable is explicitly set,
  so an unset runtime value falls back to the build-time flag instead of forcing
  it off.
- `supabaseUrl` + `supabaseAnonKey` (`COJAM_SUPABASE_URL` +
  `COJAM_SUPABASE_ANON_KEY`): emitted only as a pair; emitting just one would mix
  the runtime project with the build-time fallback of the other, pointing the
  client at two different Supabase projects.

`apps/web/lib/runtimeEnv.ts` consumes the contract: `getRuntimeEnv()` reads
`window.__COJAM_ENV__` (undefined on the server or before `/env.js` has run) and
`pickEnv()` resolves a value runtime first, then the build-time `NEXT_PUBLIC_*`,
then a default; blank or whitespace-only values count as unset.

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
  addedBy: string;     // display name
  addedByUserId?: string; // authenticated userID of the adder, server-stamped
  addedAt?: number;    // unix ms when queued, server-stamped (absent on older tracks)
  artworkUrl?: string; // album art, client-supplied at add time (server validates https, ≤512 chars)
};

type RoomState = {
  roomId: string;
  queue: TrackRef[];        // ordered; head = now playing
  nowPlayingId?: string;    // queue entry id
  hostUserId?: string;      // userID of the room host (RFC-0005; empty when room auth is off)
  radioEnabled: boolean;    // refill the queue with similar tracks when it runs dry
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
  name: string;            // sender display name (client-supplied, capped at 60)
  userId?: string;         // server-stamped connection identity; empty when room auth is off
  text: string;            // trimmed, 1..300 chars
  sentAtServerMs: number;  // server clock (unix ms)
};
```

Reconnect: centrifuge recovery + client re-issues `room.join` on reconnect; server replies with current `RoomState`; client replaces local state if `version` is newer.

## Method Details

- **`queue.reorder`**: Move a queued track to a new position. Index is clamped to `[0, len-1]`. Idempotent: re-ordering to the same position is a no-op. Does not change `nowPlayingId`.
- **`now_playing.advance`**: Advance to the next track after the one specified by `afterId`. IDEMPOTENT: if `nowPlayingId != afterId`, it's a no-op (another client already advanced). If `afterId` is the last track in the queue, clears `nowPlayingId` (queue finished). Used by clients to auto-advance when the current track ends.

## Authorization

Mutating RPCs (`queue.add`, `queue.remove`, `queue.reorder`, `queue.vote`, `now_playing.set`, `now_playing.advance`, `playlist.import`, `radio.set`, `room.set_public`, `transport.play`, `transport.pause`, `transport.seek`) and the chat RPCs (`chat.send`, `chat.history`, which are membership-gated but never mutate `RoomState`) require the caller to be a **member** of the target room. A client becomes a member by subscribing to the room's `room:<id>` channel or by calling `room.join`; membership is dropped on disconnect. Subscribing is the reconnect-safe path (centrifuge re-subscribes automatically). A non-member mutating RPC is rejected with `ErrorPermissionDenied` before dispatch. `room.join` enrolls and is always allowed. This prevents an unauthenticated client from mutating an arbitrary room by guessing its id. Enforced at the transport boundary (where the client id is known); `HandleRPC` stays transport-independent.

Rules: state carries metadata only, never audio. Each client plays the head track through its own platform SDK on explicit user gesture.
