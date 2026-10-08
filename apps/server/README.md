# Music Jam Server

Go realtime server for collaborative music jamming with WebSocket support.

## Stack

- **chi** - HTTP router
- **centrifuge** - Embeddable realtime node (v0.38.0)
- **golang-jwt** - Connection tokens and Supabase JWT verification
- **uuid** - Track ID generation

## Quick Start

```bash
cd /Volumes/External\ HD/Desenvolvimento/music-jam/apps/server

# Download dependencies
go mod download

# Build
go build ./cmd/server

# Run
./server
```

Server listens on `:8080`.

## Environment Variables

### Required for features

| Variable | Purpose | Example |
|----------|---------|---------|
| `YOUTUBE_API_KEY` | YouTube Data API key (optional, enables YouTube search) | `AIzaSy...` |

## Endpoints

### Health

```
GET /healthz
```

Response:
```json
{"status":"ok"}
```

### WebSocket (Centrifuge)

```
WS /connection/websocket
```

Connect and use RPC methods:
- `room.join` `{roomId, name}` - Join a room, returns current RoomState
- `queue.add` `{roomId, track}` - Add track to queue
- `queue.remove` `{roomId, trackId}` - Remove track from queue
- `now_playing.set` `{roomId, trackId}` - Set now playing track

Subscribe to channel `room:<roomId>` for state updates.

## Development

### Tests

```bash
go test -race ./...
```

Table tests included for:
- Queue reducer (add, remove, set now playing, version bumps)
- Match confidence scoring

### Verify

```bash
go build ./...
go vet ./...
go test -race ./...
```

All green = ready to ship.

## Architecture

### `internal/queue`

Pure queue reducer: `RoomState` with `Add`, `Remove`, `SetNowPlaying` operations. Each operation bumps version and returns updated state.

### `internal/hub`

Room registry with Centrifuge integration. RPC handlers serialize to JSON and publish state changes to `room:<roomId>` channel.

### `internal/match`

Music search integration:
- **MusicBrainzLookupISRC**: HTTP lookup via MusicBrainz API (User-Agent required, 1 req/s rate limit)
- **YouTubeSearch**: YouTube Data API v3 search (requires key), naive token-overlap confidence scoring

### `cmd/server`

chi mux + centrifuge node + graceful shutdown. No auth v0 (anonymous connections).
