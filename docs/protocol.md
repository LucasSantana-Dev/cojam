# Room protocol v0

Transport: centrifuge (server: Go `centrifugal/centrifuge`; client: `centrifuge-js`). One centrifuge channel per room: `room:<roomId>`. All payloads JSON. Server is authoritative for queue state; clients send RPC-style commands, server publishes resulting state to the channel.

## Client → server (centrifuge RPC, method names)

| method | params | result |
|---|---|---|
| `room.join` | `{ roomId: string, name: string }` | `RoomState` |
| `queue.add` | `{ roomId, track: TrackRef }` | `RoomState` |
| `queue.remove` | `{ roomId, trackId: string }` | `RoomState` |
| `queue.reorder` | `{ roomId, trackId: string, toIndex: number }` | `RoomState` |
| `now_playing.set` | `{ roomId, trackId: string }` | `RoomState` |
| `now_playing.advance` | `{ roomId, afterId: string }` | `RoomState` |

### Roles & authorization (RFC-0005, behind `FEATURE_ROOM_AUTH`)

When `FEATURE_ROOM_AUTH` is on, connections present a server-signed token (anonymous stable
`sub`) and the server records a room **host** (the first authenticated joiner; reclaimed if the
host leaves). Host-only RPCs are rejected with `ErrorPermissionDenied` for non-hosts; the server
is authoritative (the web UI also hides these controls for listeners, but that is convenience
only). When the flag is off, every member has equal rights (v0), unchanged.

| RPC | Who may call (flag on) |
|---|---|
| `queue.add` | any member |
| `room.join`, `sync.ping`, reads | any member |
| `now_playing.set` / `now_playing.advance` | host only |
| `queue.reorder` / `queue.remove` | host only |
| `radio.set`, `playlist.import` | host only |
| `transport.play` / `transport.pause` / `transport.seek` | host only |

Follow-up: `queue.remove` is host-only in v1; letting listeners remove their own tracks needs
`TrackRef.addedBy` to carry the stable `userId` (today it is a display name).

## Server → channel publications

Every accepted mutation publishes the full `RoomState` (v0 keeps it simple; deltas later if payloads grow):

```json
{ "type": "room.state", "state": RoomState }
```

Presence: centrifuge native presence on the channel (join/leave events + presence query), no custom messages.

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
  };
  addedBy: string;     // display name
};

type RoomState = {
  roomId: string;
  queue: TrackRef[];        // ordered; head = now playing
  nowPlayingId?: string;    // queue entry id
  version: number;          // monotonic, bumps per mutation; clients drop stale
};
```

Reconnect: centrifuge recovery + client re-issues `room.join` on reconnect; server replies with current `RoomState`; client replaces local state if `version` is newer.

## Method Details

- **`queue.reorder`**: Move a queued track to a new position. Index is clamped to `[0, len-1]`. Idempotent: re-ordering to the same position is a no-op. Does not change `nowPlayingId`.
- **`now_playing.advance`**: Advance to the next track after the one specified by `afterId`. IDEMPOTENT: if `nowPlayingId != afterId`, it's a no-op (another client already advanced). If `afterId` is the last track in the queue, clears `nowPlayingId` (queue finished). Used by clients to auto-advance when the current track ends.

## Authorization

Mutating RPCs (`queue.add`, `queue.remove`, `queue.reorder`, `now_playing.set`, `now_playing.advance`) require the caller to be a **member** of the target room. A client becomes a member by subscribing to the room's `room:<id>` channel or by calling `room.join`; membership is dropped on disconnect. Subscribing is the reconnect-safe path (centrifuge re-subscribes automatically). A non-member mutating RPC is rejected with `ErrorPermissionDenied` before dispatch. `room.join` enrolls and is always allowed. This prevents an unauthenticated client from mutating an arbitrary room by guessing its id. Enforced at the transport boundary (where the client id is known); `HandleRPC` stays transport-independent.

Rules: state carries metadata only, never audio. Each client plays the head track through its own platform SDK on explicit user gesture.
