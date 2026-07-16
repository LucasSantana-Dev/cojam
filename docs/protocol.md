# Room protocol v0

Transport: centrifuge (server: Go `centrifugal/centrifuge`; client: `centrifuge-js`). One centrifuge channel per room: `room:<roomId>`. All payloads JSON. Server is authoritative for queue state; clients send RPC-style commands, server publishes resulting state to the channel.

## Client → server (centrifuge RPC, method names)

| method | params | result |
|---|---|---|
| `room.join` | `{ roomId: string, name: string }` | `RoomState` |
| `queue.add` | `{ roomId, track: TrackRef }` | `RoomState` |
| `queue.remove` | `{ roomId, trackId: string }` | `RoomState` |
| `now_playing.set` | `{ roomId, trackId: string }` (host only, v0: anyone) | `RoomState` |

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

Rules: state carries metadata only, never audio. Each client plays the head track through its own platform SDK on explicit user gesture.
