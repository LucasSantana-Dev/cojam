# F1: Public rooms + live strip

Issue: #129 (https://github.com/LucasSantana-Dev/cojam/issues/129)
Status: spec, ready for implementation
Date: 2026-07-22
Scope note: docs/specs/ is internal-only by repo convention (like docs/rfc/, docs/adr/); do not commit.

## 1. Goal and non-goals

Goal: let a host opt a room into a public directory, and let landing visitors see
and join live public rooms. The landing page hero card at
`apps/web/app/page.tsx:580-618` is today a static, aria-hidden mock
("Example room . NEON-4821"); it becomes a live strip of real public rooms.

Non-goals:

- No search, tags, categories, or pagination (cap of 20 rooms is the v1 directory).
- No room names beyond a single optional plain-text label set by the host.
- No un-listing of rooms mid-session other than the host toggling the flag off.
- No changes to the join flow: joining a public room still goes through the
  existing name form in `apps/web/app/room/[id]/client.tsx:273-352`.
- No audio or playback changes (per-user streams, metadata only; unchanged).

Privacy default: private. `public` defaults to false everywhere (zero value in
Go, absent key in JSON), so existing persisted rooms and all current behavior
are unchanged unless a host explicitly opts in.

## 2. Protocol changes (`packages/shared/src/protocol.ts`)

### 2.1 RoomState additions

```ts
export type RoomState = {
  roomId: string;
  queue: TrackRef[];
  nowPlayingId?: string;
  hostUserId?: string;
  radioEnabled: boolean;
  version: number;
  transport?: TransportState;
  public?: boolean;  // new: host-set directory opt-in; absent = private
  name?: string;     // new: optional host-set room label shown in the directory
};
```

`name` is a room label, not to be confused with the `name` param of `room.join`,
which is the joining member's display name (`apps/server/internal/hub/hub.go:601-604`).
That param is untouched.

### 2.2 New type

```ts
export type PublicRoomSummary = {
  roomId: string;
  name?: string;          // present only if the host set one
  memberCount: number;    // connected members (join + subscribe enrollment)
  nowPlaying?: { title: string; artist: string };
};
```

### 2.3 New RPC methods

| method | params | result | authz | Version bump |
|---|---|---|---|---|
| `room.set_public` | `{ roomId: string, public: boolean, name?: string }` | `RoomState` | member + host only | yes |
| `room.list` | `{}` | `{ rooms: PublicRoomSummary[] }` | any connected client (read, not membership-gated) | n/a (read) |

`room.set_public`:

- `name` optional; when present it replaces the room label. Trim, cap at 60
  chars; empty after trim clears the label. Reject > 60 with a `UserError`
  (surfaces as centrifuge code 400 via `rpcClientError`, hub.go:87-96).
- Mutates published state, so it MUST bump `RoomState.Version` in the mutate
  closure (AGENTS.md gotcha #2; the web `setState` guard at
  `apps/web/lib/realtime.ts:37-39` drops publications whose version is not newer).
- Response is the full `RoomState`, same convention as every mutation
  (`docs/protocol.md:56`).

`room.list`:

- Returns only rooms currently loaded in the hub with `Public == true`
  (never calls `GetOrCreateRoom`; a listing must not create or load rooms).
- Sorted by `memberCount` descending, then `roomId` ascending for stability.
- Capped at 20 entries server-side.
- Exposes only the summary fields above. Queue contents, host id, transport,
  and vote data stay room-channel-only.

## 3. Server design (`apps/server`)

### 3.1 State and persistence

- `apps/server/internal/queue/queue.go`: add `Public bool` and `Name string`
  to `RoomState` (json tags `public,omitempty`, `name,omitempty`). No new
  methods needed; the hub closure sets fields directly like `radio.set` does
  (hub.go:1044-1048).
- Persistence is free: `store.Store` marshals the whole `RoomState`
  (`apps/server/internal/store/store.go`), so the flag and label survive
  server restarts with zero store changes. Rooms saved before this feature
  load with `Public == false` (private). This is the intended behavior: the
  opt-in persists until the host revokes it.

### 3.2 Hub changes (`apps/server/internal/hub/hub.go`)

- `mutatingMethods` (hub.go:190): add `room.set_public` (membership-gated).
- `hostOnlyMethods` (hub.go:208): add `room.set_public` (directory membership
  is a room-control decision, same class as `radio.set`).
- `dispatch`: new cases.
  - `room.set_public`: validate, then `h.mutate` with
    `s.Public = req.Public; s.Name = req.Name; s.Version++`.
  - `room.list`: read-only walk of `h.rooms` under `h.mu.RLock`, skipping
    `!room.State.Public`. For each, take `room.mu`, copy the summary fields,
    resolve `nowPlaying` from `NowPlayingID` + queue lookup (omit when unset).
- Member count: invert `h.members` (clientID -> roomIDs), which is enrolled by
  `Join` on both `room.join` (hub.go:376) and channel subscribe
  (`apps/server/cmd/server/main.go:394`) and cleared on disconnect
  (main.go:384). This works with a nil centrifuge node (tests) and matches the
  membership model; it counts connections, so one person in two tabs counts
  twice (accepted, documented).
- Filter dead entries from the listing: skip rooms with `memberCount == 0`
  AND an empty queue (loaded-but-idle rooms; the hub never evicts today).
- Feature flag: `WithPublicRooms(enabled bool)` on Hub, wired in
  `cmd/server/main.go` behind `featureEnabled("FEATURE_PUBLIC_ROOMS", false)`,
  default off (dark-ship, same posture as `FEATURE_SYNC`). When off, both new
  RPCs return `centrifuge.ErrorMethodNotFound` (precedent: `transport.*`,
  hub.go:1052).

### 3.3 Rate limiting

`room.list` does not fan out to third-party APIs, so it does not belong in
`fanoutMethods` (`apps/server/internal/hub/ratelimit.go:11-17`). It is still
an unauthenticated read that landing visitors will poll, so give it its own
bucket reusing the existing `rateLimiter` type:

- New Hub field `listLimiter *rateLimiter`, initialized in `NewHub` with
  `newRateLimiter(5, 2*time.Second, time.Now)` (burst 5, one token per 2s).
- New `listMethods = map[string]bool{"room.list": true}` checked in
  `handleRPC` next to `checkFanoutLimit` (hub.go:553-597), keyed by the same
  `rateLimitKey(clientID, userID)` (hub.go:1197), so anonymous pollers are
  limited per connection.
- Rejection returns `userErrorf("too many requests, slow down")` (client sees
  centrifuge code 400), consistent with fanout rejections.
- `room.set_public` needs no limiter: host-only, one toggle per room.

## 4. Web design (`apps/web`)

### 4.1 Feature flag (runtime, per RFC-0006 / #126)

- `apps/web/lib/features.ts`: add `publicRooms` to `Features`,
  `NEXT_PUBLIC_FEATURE_PUBLIC_ROOMS`, default false.
- Runtime override: `COJAM_FEATURE_PUBLIC_ROOMS` via `/env.js`. #126 is
  migrating flags to the generic `RuntimeEnv.features` map +
  `useRuntimeFeatures()` hook (`docs/rfc/0006-runtime-feature-config.md:38-48`);
  this flag should land on that hook if #126 is merged first, otherwise follow
  the existing one-off pattern (`spotifyEnabled`/`roomAuthEnabled` in
  `apps/web/app/env.js/route.ts:32-39`) plus the hydration-safe
  `useSyncExternalStore` read (`apps/web/app/room/[id]/client.tsx:71-75`),
  and migrate with #126. Render gates must stay hydration-safe either way.

### 4.2 Data fetching: `apps/web/lib/publicRooms.ts` (new)

The landing page has no room subscription and `joinRoom` is room-scoped, so add
a small module that keeps one shared, lazy "service" Centrifuge connection (no
room channel):

- Reuse `resolveConnectionToken` (realtime.ts:106-114) and the `pickEnv` wsUrl
  resolution (realtime.ts:121-125).
- `listPublicRooms(): Promise<PublicRoomSummary[]>` calls `room.list` and
  returns `[]` on any error (feature off, rate limited, unreachable). The
  caller renders the existing static mock on `[]`, so failure is invisible.
- Poll every 15s only while `document.visibilityState === 'visible'`; stop
  when hidden; disconnect the service client when no subscribers remain.

### 4.3 Components

- `apps/web/app/components/LiveRoomsStrip.tsx` (new, client): given summaries,
  renders up to 5 cards: room label (`name` or `roomId`), "N listening", now
  playing title/artist when present, and a Join link to `/room/<roomId>`.
  Reuses the `.room-card` visual language of the current mock; new classnames
  must pass `./scripts/check_web_drift.sh` (keyframes + palette).
- `apps/web/app/page.tsx`: when the flag is on, mount `LiveRoomsStrip` in place
  of the static `aside.room-card` mock (page.tsx:580-618) once a non-empty
  list arrives. Flag off, empty list, or fetch failure: render the current
  mock unchanged (it is honestly labeled "Example room" and aria-hidden).
  Keep the mock in the tree as the default; the live strip is an enhancement,
  not a removal, so a deploy with zero public rooms never shows a hole.
- Room side, `apps/web/app/room/[id]/client.tsx` header (372-407): a "Public"
  toggle next to `ShareRoomButton`, rendered only when `hostControl`
  (client.tsx:132-136) and the flag are on; checked state from
  `store.state.public`; calls `setRoomPublic`. Optional one-line label input
  shown when enabling (sends `name`). Non-hosts see nothing.
- `apps/web/lib/realtime.ts`: add
  `setRoomPublic(roomId: string, isPublic: boolean, name?: string)` RPC
  wrapper following the existing wrappers (realtime.ts:308-311). RoomState
  type flows from `@cojam/shared`; no local redefinition.

## 5. Edge cases and failure modes

- Existing rooms stay private: zero-value false on load; no migration.
- Host leaves: host reclaim on next authenticated join (hub.go:615-625)
  transfers control of the toggle; the flag itself persists on the room.
- Host toggles off: the room vanishes from the next poll (15s worst case).
  Users already inside are unaffected; the room channel is unchanged.
- Anonymous rooms: with `FEATURE_ROOM_AUTH` off there is no host
  (`HostUserID` empty, hub.go:392-401 skips the host gate), so any member can
  toggle public. Accepted and documented, same as `radio.set` today.
- Empty queue: `nowPlaying` omitted; card shows member count only.
- Nobody listening: 0-member public rooms with non-empty queues still list
  (a paused room is still joinable); 0-member AND empty-queue rooms are
  filtered as dead.
- Rate limited poller: `listPublicRooms` swallows the 400 and keeps the last
  good list; the strip never errors visibly.
- Guest vs account users: listing needs neither membership nor account; rate
  limiting keys per connection for guests (`client:<id>`) and per user for
  accounts (`user:sb:<uuid>`).

## 6. Acceptance criteria (mapped to verify commands)

Server (`cd apps/server && go test -race ./...`, `go vet ./...`):

- New `apps/server/internal/hub/hub_public_test.go`:
  - `room.set_public` from a non-member is rejected with PermissionDenied
    (mutatingMethods gate).
  - With `FEATURE_ROOM_AUTH` on and a host assigned, a non-host member is
    rejected; the host succeeds (hostOnlyMethods gate).
  - The mutation bumps `RoomState.Version` (explicit assertion; gotcha #2).
  - A fresh room is private and absent from `room.list`; after
    `room.set_public {public:true}` it appears with correct `memberCount` and
    `nowPlaying`; after `{public:false}` it disappears.
  - Listing is capped at 20 and sorted by memberCount desc.
  - Dead rooms (0 members, empty queue) are excluded.
  - `room.list` is rejected with the rate-limit UserError after the burst
    (shrink the limiter in test like `hub_ratelimit_test.go:34`).
  - With `WithPublicRooms(false)`, both RPCs return ErrorMethodNotFound.
  - Persistence round-trip: saved + reloaded room keeps `public`/`name`
    (follow `hub_persist_test.go`).
- `go vet ./...` clean.

Web (`cd apps/web && npx tsc --noEmit`, `pnpm lint`, `npx vitest run`):

- Shared types compile across the workspace (`@cojam/shared` bump).
- Unit: `resolveFeatures` includes `publicRooms` default false; strip renders
  cards from fixture summaries (member count, now playing, join href); empty
  list falls back to mock; `setRoomPublic` sends the right payload.
- e2e (`pnpm --filter web e2e` only; never raw playwright against a dev server
  on :3000, AGENTS.md gotcha #1): with the flag on, landing shows a real room
  created and made public via RPC; clicking the card lands on `/room/<id>`.
- `./scripts/check_web_drift.sh` clean after strip CSS.
