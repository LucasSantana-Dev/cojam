# F8: Room chat

Issue: #131 (https://github.com/LucasSantana-Dev/cojam/issues/131)
Status: spec, ready for implementation
Date: 2026-07-22
Scope note: docs/specs/ is internal-only by repo convention (like docs/rfc/, docs/adr/); do not commit.

## 1. Goal and non-goals

Goal: per-room text chat. Any member (guest or account) can send short
messages; everyone in the room sees them live; late joiners get recent
history.

Decision: chat is EPHEMERAL, in-memory only. Not persisted, not part of
`RoomState`.

- Chat is conversational context, not room state. Putting it in `RoomState`
  would force a Version bump plus a full-state publish for every message
  (the `mutate` path, `apps/server/internal/hub/hub.go:487-525`), fanning out
  the entire queue to say one line.
- Persistence would run a `store.Save` write-through per message
  (hub.go:503-517), growing Postgres with session chatter, and would create
  retention/moderation obligations v1 does not want.
- An in-memory ring per room plus a tiny per-message publication keeps the
  hot path cheap and the protocol's state snapshot small.

Non-goals:

- No persistence, no cross-session history (restart = empty chat).
- No moderation tooling, deletion, editing, reactions, or rich content.
- No direct messages, no presence-integrated typing indicators.
- No chat on the landing page; room-scoped only. (The mock chat line at
  `apps/web/app/page.tsx:614` stays decorative; F1 owns that card.)

## 2. Protocol changes (`packages/shared/src/protocol.ts`)

### 2.1 New types

```ts
export type ChatMessage = {
  id: string;              // server-assigned uuid
  roomId: string;
  name: string;            // sender display name (client-supplied, capped; like TrackRef.addedBy)
  userId?: string;         // server-stamped connection identity; empty when room auth is off
  text: string;            // trimmed, 1..300 chars
  sentAtServerMs: number;  // server clock, like TransportState.updatedAtServerMs
};

export type ChatMessagePub = {
  type: 'chat.message';
  message: ChatMessage;
};
```

`RoomStatePub` (`packages/shared/src/protocol.ts:37-40`) stays as-is; the room
channel now carries two publication shapes, distinguished by `type`. The
client publication handler already switches on `pub.type`
(`apps/web/lib/realtime.ts:185-190`).

### 2.2 New RPC methods

| method | params | result | authz | Version bump |
|---|---|---|---|---|
| `chat.send` | `{ roomId: string, text: string, name: string }` | `{ message: ChatMessage }` | member (NOT host-only) | no (not RoomState) |
| `chat.history` | `{ roomId: string }` | `{ messages: ChatMessage[] }` | member | n/a (read) |

- `chat.send` result is the stamped message (not `RoomState`), the documented
  escape for reads/non-state responses ("Reads return whatever JSON they
  need", AGENTS.md RPC pattern). The authoritative delivery to everyone,
  including the sender, is the `chat.message` publication.
- `chat.history` returns the last 50 messages, oldest first.
- Validation: `text` trimmed, 1..300 chars (300 aligns with
  `maxImportFieldLen`, hub.go:27); `name` trimmed, capped at 60 chars (display
  name only, same trust level as `addedBy`); `userId` is always
  server-stamped from the connection, never trusted from params (the
  `addedByUserId` pattern, hub.go:651). Violations -> `UserError`
  (centrifuge code 400 via `rpcClientError`, hub.go:87-96).
- Version discipline (the issue's "Version discipline" acceptance): chat MUST
  NOT bump `RoomState.Version` and MUST NOT trigger `store.Save`. The
  version-guarded `setState` (realtime.ts:37-39) only applies to
  `room.state` publications; chat appends through its own store path. A
  server test guards this (section 6) so nobody later "simplifies" chat into
  `RoomState` and reintroduces per-message full-state fan-out.

## 3. Server design (`apps/server`)

### 3.1 Storage: in-memory ring on Room

- `Room` (`apps/server/internal/hub/hub.go:142-145`) gains
  `chat []ChatMessage`, guarded by the existing `room.mu`. Append-only ring
  capped at 50 (`maxChatHistory = 50`): on overflow, drop the oldest.
  Lifecycle follows the room; rooms are never evicted today, and 50 messages
  at roughly 200 bytes each is negligible per room.
- No `store.Store` changes. `queue.RoomState` is untouched.

### 3.2 Hub changes (`apps/server/internal/hub/hub.go`)

- `mutatingMethods` (hub.go:190): add `chat.send` AND `chat.history`. This map
  is what `Authorize` (hub.go:365-404) uses for the membership gate; adding
  both gives membership enforcement with zero `Authorize` changes. Update the
  map's comment from "RPCs that change room state" to "membership-gated RPCs"
  since chat.send does not call `mutate`. Neither method goes in
  `hostOnlyMethods`: chat is every member's channel, guests included.
- `dispatch` cases:
  - `chat.send`: validate; stamp `id` (uuid, same as track ids), `userId`
    from the `userID` param, `sentAtServerMs`; append to the ring under
    `room.mu`; then `publishChat`. Returns `{ message }`.
  - `chat.history`: copy the ring under `room.mu`, return `{ messages }`.
- `publishChat(roomID, message)` mirrors `publish` (hub.go:527-540) on the
  same `room:<id>` channel with payload `{ "type": "chat.message",
  "message": ... }`; nil node (tests) skips. Ordering note: append-then-
  publish inside the room lock's critical section is not required; publish
  after unlock, accepting that two concurrent sends may publish out of append
  order. Clients sort/append by arrival and dedupe by id; history order is the
  ring order. Acceptable for chat.
- `handleRPC` instrumentation (hub.go:553-585) covers the new methods for
  free (one slog record + histogram per call).
- Feature flag: `WithChat(enabled bool)` on Hub, wired in
  `cmd/server/main.go` behind `featureEnabled("FEATURE_ROOM_CHAT", false)`,
  default off (dark-ship, like `FEATURE_SYNC`). Off -> both cases return
  `centrifuge.ErrorMethodNotFound` (precedent: `transport.*`, hub.go:1052).

### 3.3 Rate limiting

Chat is the canonical spammable RPC, so it reuses the #91 token bucket
(`apps/server/internal/hub/ratelimit.go`):

- New Hub field `chatLimiter *rateLimiter`, `newRateLimiter(5, 2*time.Second,
  time.Now)` in `NewHub` (burst 5 messages, one token per 2s).
- New `chatMethods = map[string]bool{"chat.send": true}` checked in
  `handleRPC` next to `checkFanoutLimit` (hub.go:587-597), keyed by the
  existing `rlKey` (`rateLimitKey(clientID, userID)`, hub.go:1197): guests are
  limited per connection, accounts per user.
- Rejection -> `userErrorf("too many requests, slow down")` (client-visible
  400), same text as fanout rejections.
- Keep chat out of `fanoutMethods`: that budget protects third-party API
  quotas (ratelimit.go:8-10); chat never leaves the server.
- `chat.history` is not limited: bounded (50 messages), membership-gated, and
  called once per join/rejoin.

## 4. Web design (`apps/web`)

### 4.1 Feature flag (runtime, per RFC-0006 / #126)

- `apps/web/lib/features.ts`: add `roomChat`, env
  `NEXT_PUBLIC_FEATURE_ROOM_CHAT`, default false.
- Runtime: `COJAM_FEATURE_ROOM_CHAT` via `/env.js`, consumed through
  `useRuntimeFeatures()` if #126 has landed, otherwise the existing one-off +
  `useSyncExternalStore` pattern (see F1 spec section 4.1 for exact
  references) and migrate with #126.

### 4.2 Store and RPC (`apps/web/lib/realtime.ts`)

- Store additions: `chat: ChatMessage[]`, `setChat(messages)`,
  `addChatMessage(message)` (dedupe by `id`, cap the client list at 100 by
  dropping oldest).
- Publication handler (realtime.ts:185-190): add
  `if (pub.type === 'chat.message') store.addChatMessage(pub.message)`.
- Wrappers: `sendChat(roomId, text, name)` and `fetchChatHistory(roomId)`,
  following the existing wrappers; send errors normalized with
  `rpcErrorMessage` (realtime.ts:268-272).
- History load: after a successful `room.join` (realtime.ts:245-250) and
  after the B10 reconnect rejoin (realtime.ts:162-171), call
  `fetchChatHistory` and `setChat` when the flag is on. This heals messages
  missed during a disconnect; dedupe by id makes refetch idempotent.
- Clear `chat` in `joinRoom` alongside the `activeRoom` reset
  (realtime.ts:134) so switching rooms never shows the previous room's chat.

### 4.3 Component: `apps/web/app/room/components/ChatPanel.tsx` (new)

- Layout: message list (auto-scroll to latest, capped scrollback), each row
  showing an initial avatar (`avatarGradient`, used in client.tsx:303-313),
  display name, text, and relative time from `sentAtServerMs`. Input with a
  300-char cap and send on Enter; send button disabled while disconnected or
  text empty.
- Sender name: the joined `store.name` (already the presence name).
- Empty state: "No messages yet. Say hi." plus the disabled-input reason
  when disconnected.
- Rate-limit and send failures: inline error text via `rpcErrorMessage`,
  same pattern as `QueuePanel`'s `actionError`
  (`apps/web/app/room/components/QueuePanel.tsx:36,52`).
- Placement: right column under `QueuePanel`
  (`apps/web/app/room/[id]/client.tsx:615-617`), rendered only when the flag
  is on. Server-first: no optimistic append; the message appears when the
  publication round-trips (fast on the same channel), so there is no
  duplicate/rollback handling.
- Guests participate identically to account users: `userId` is empty under
  anonymous connections, `name` is the join-form name, membership is enforced
  per connection. Matches the room-auth model (`docs/protocol.md:32-52`).

## 5. Edge cases and failure modes

- Join late: `chat.history` seeds the last 50 messages; older ones are gone
  by design (ring cap).
- Disconnect/reconnect: centrifuge resubscribes; messages published during
  the drop are missed live, then the rejoin refetches history and dedupes.
  Worst case a few seconds of gap that self-heals.
- Server restart: chat is empty; rooms and queues are unaffected (ephemeral
  by design, documented to users nowhere; chat simply starts fresh).
- Empty text / whitespace-only: rejected with a 400 UserError; UI also
  disables send for empty trimmed input.
- Spam: per-caller limiter rejects with "too many requests, slow down",
  shown inline; the limiter is per user/connection, so one spammer does not
  throttle the room.
- Non-member guessing a room id: `chat.send` and `chat.history` are
  membership-gated in `Authorize` -> PermissionDenied before dispatch, same
  protection mutations have today (hub.go:379-387).
- `FEATURE_ROOM_AUTH` off: `userId` empty; rate limiting falls back to
  per-connection keys; all behavior unchanged otherwise.
- Very long single messages: capped at 300 chars server-side regardless of
  the client input cap.
- Clock skew in timestamps: `sentAtServerMs` is server time; relative-time
  rendering uses the existing clock-offset machinery only if trivially
  available, otherwise plain relative time from receipt (acceptable for chat).

## 6. Acceptance criteria (mapped to verify commands)

Server (`cd apps/server && go test -race ./...`, `go vet ./...`):

- New `apps/server/internal/hub/hub_chat_test.go`:
  - Non-member `chat.send` and `chat.history` rejected with PermissionDenied.
  - `chat.send` rejects empty and >300-char text with a UserError; stamps
    `id`, `userId`, `sentAtServerMs`; returns the message.
  - History returns messages oldest-first and caps at 50 (send 60, get the
    last 50).
  - Version discipline guard: after `chat.send`, a `room.join` returns a
    `RoomState` with an unchanged `Version` and no chat content in the state
    payload (chat is not RoomState).
  - Ephemeral guard: `chat.send` does not call `store.Save` (instrument a
    counting store, following `hub_persist_test.go` patterns).
  - Rate limited after the burst (shrink the limiter in test like
    `hub_ratelimit_test.go:34`).
  - `WithChat(false)` -> ErrorMethodNotFound for both methods.
- `go vet ./...` clean.

Web (`cd apps/web && npx tsc --noEmit`, `pnpm lint`, `npx vitest run`):

- Shared `ChatMessage` / `ChatMessagePub` types compile workspace-wide.
- Unit: store `addChatMessage` dedupes by id and caps at 100; publication
  handler routes `chat.message` vs `room.state`; ChatPanel renders the empty
  state, sends trimmed text, and shows the inline error on rejection
  (existing vitest patterns in `app/room/components/*.test.tsx`).
- e2e (`pnpm --filter web e2e` only, never raw playwright on :3000, AGENTS.md
  gotcha #1): with the flag on, joining a room, sending a message, and seeing
  it appear; reload keeps the last 50 via history.
- `./scripts/check_web_drift.sh` clean after panel CSS.
