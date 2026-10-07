# 310: Screen share v1 (WebRTC P2P mesh, private rooms only)

Issue: [#310](https://github.com/LucasSantana-Dev/cojam/issues/310)
Status: spec, ready for critic review
Date: 2026-10-07
Decision record: ADR-0008 (`docs/adr/0008-screen-share-webrtc-mesh.md`, local
only by repo convention; the binding constraints are restated in section 1 so
this file stands alone)
Depends on: #258 (stage layout, merged in #315), #259 (reports, age gate),
#253 (terms clause on shared content, before the production flag flips)

> **Not legal advice.** Section 7 maps the mechanism to the duties discussed in
> `259-eca-minor-safety.md`. Whether that mapping is sufficient is a question
> for the legal review #259 and #253 already require.

## 0. Why, and what changes

Owner decision, 2026-10-07, not reopened here: build real screen share,
inspired by golive.nemtudo.me.

This is the first CoJam feature in which members exchange media bytes. The
server still never carries media in v1 (it relays SDP and ICE candidates,
which are connection metadata), so the licensing cost model that kept CoJam
off the Turntable.fm and plug.dj path is intact. What is gone is the product
property that CoJam never causes media to move between its users. ADR-0008
separates those two properties; this spec is written to keep the first one
and to make losing it a later, explicit decision (TURN or SFU) instead of a
drift.

Context on Brazil, verified against the existing specs and the ANPD's own
announcement: on 2026-08-12 the **ANPD**, not the AGU, ordered Discord to
suspend its livestream feature as a preventive measure under ECA Digital (Lei
15.211). Discord and Discord voice stayed up. Screen share to a small private
group is the closest thing CoJam can offer to the suspended feature, which is
also why it carries the most ECA Digital exposure of anything in the backlog.

## 1. Binding v1 constraints

From ADR-0008. Any change needs an ADR amendment and a critic pass.

| # | Constraint | Enforced where |
|---|---|---|
| C1 | P2P mesh, one `RTCPeerConnection` per viewer, broadcaster-initiated | client; server only relays |
| C2 | One broadcaster per room | `screen.start` in the room mutation |
| C3 | At most 5 viewers per share | `screen.watch` admission, server-side |
| C4 | Server relays SDP/ICE only, never media | no media code server-side; review assertion |
| C5 | Public STUN only; no TURN, no SFU until revenue (#262) | client ICE config |
| C6 | Private rooms only: `screen.start` refused when `public`, `room.set_public {public:true}` refused while live | both inside the room mutation closure |
| C7 | Host-controlled; requires `FEATURE_ROOM_AUTH` | Authorize + config fatal |
| C8 | Age affirmation before broadcasting | client gate + `ageAffirmed` param |
| C9 | Report kind `broadcast`, subject server-stamped | `/api/report` |
| C10 | `FEATURE_SCREENSHARE` / `COJAM_FEATURE_SCREENSHARE`, default off | server config, `features.ts` |
| C11 | Prometheus series exist and are scraped before prod rollout | rollout checklist |

**Out of v1:** camera, voice, recording, multiple broadcasters,
viewer-to-viewer links, desktop app, simulcast, TURN, SFU, shares in public
rooms, a viewer waiting queue.

## 2. Protocol additions (`docs/protocol.md`, `packages/shared/src/protocol.ts`)

All new RPCs exist only when `FEATURE_SCREENSHARE` is on; otherwise the server
replies `ErrorMethodNotFound` (the `transport.*` precedent). All are
membership-gated (added to `mutatingMethods`).

### 2.1 Types

```ts
type ScreenShareState = {
  broadcasterId: string;      // centrifuge clientId of the broadcasting connection
  broadcasterName: string;    // server-stamped connect-time display name
  startedAtMs: number;        // server clock (unix ms)
  viewerCount: number;        // admitted viewers, 0..5
  maxViewers: number;         // 5 in v1; sent so the client never hardcodes it
};

type RoomState = {
  // ...existing fields
  screen?: ScreenShareState;  // present only while a share is live
};
```

**Why `clientId`, not `userId`.** Signaling targets a connection, not a person:
one account in two tabs is two peers. Presence is already keyed by `clientId`
(`docs/protocol.md`, Presence), and `room.kick` already takes a `clientId`, so
the client can map a broadcaster to a presence entry and the host can kick
them with ids it already has. The server keeps the broadcaster's `userId`
internally for host checks, reports and audit.

**`screen` is never persisted.** It describes live connections that die with
the process. `mutate` already deep-copies state before `store.Save`
(`hub.go`, the `stateCopy` unmarshal); the copy gets `Screen = nil` before the
save, and `GetOrCreateRoom` clears it on load as a second guard. A reloaded or
restarted room must never claim a live share. A start or stop still bumps
`version` (version-guarded clients drop unbumped publications), which costs one
store write per transition; viewer count changes bump it too, bounded at about
ten per session.

### 2.2 RPCs

| method | params | result | who |
|---|---|---|---|
| `screen.start` | `{ roomId, ageAffirmed: true }` | `RoomState` | host, or a member holding a host grant |
| `screen.stop` | `{ roomId }` | `RoomState` | the broadcaster, or the host (any share) |
| `screen.watch` | `{ roomId }` | `{ broadcasterId }` | any member except the broadcaster |
| `screen.unwatch` | `{ roomId }` | `{}` | an admitted viewer |
| `rtc.signal` | `{ roomId, to: string, payload: SignalPayload }` | `{}` | broadcaster or an admitted viewer |
| `screen.allow` (PR 7, optional) | `{ roomId, clientId }` | `{}` | host |

`screen.start` refusals, each a code-400 UserError unless noted:

- room auth off (no host): refused at config time (C7, see 4.1), and
  defensively here with "screen share needs room auth"
- caller not host and holds no grant: `ErrorPermissionDenied` through
  `hostOnlyMethods`, except when a grant exists (Authorize consults it)
- `ageAffirmed !== true`: "confirm your age to share your screen"
- room `public == true`: "screen share is only available in private rooms"
- a share already live: "<name> is already sharing"

`room.set_public` gains one refusal: `public: true` while `screen != nil` is
"stop the screen share before making the room public". `public: false` is
always allowed. Both checks live inside the `mutate` closure, under `room.mu`,
so `screen.start` and `room.set_public` serialize and cannot both win.

`screen.watch` admits the caller into the share's viewer set (C3). Refusals:
no live share ("nothing is being shared"), caller is the broadcaster, set is
full ("the share is full (5 viewers)"). Idempotent for an already-admitted
caller. On admission the server bumps `viewerCount`, publishes, and notifies
the broadcaster (2.3) so it opens the peer connection.

`screen.unwatch` removes the caller and notifies the broadcaster. Idempotent.

### 2.3 Delivering to a single client

Verified against the vendored code, not assumed:

- Server `github.com/centrifugal/centrifuge v0.38.0` has
  `func (c *Client) Send(data []byte) error` (`client.go:947`): "an
  asynchronous message, data will be just written to connection". The hub
  already resolves a connection by id the same way `roomKick` does:
  `h.node.Hub().Connections()[clientID]` (`moderation.go`).
- Client `centrifuge` 5.7.x exposes it as the `message` event on the
  `Centrifuge` instance (`types.d.ts:30`, `message: (ctx: MessageContext)`).
  `lib/realtime.ts` currently listens only for `publication` on the room
  subscription; it gains one `centrifuge.on('message', ...)` handler.

**Decision: use `Client.Send`, not a personal channel.**

A personal channel (`rtc:<clientId>`) was considered and rejected for v1:

- `OnSubscribe` in `cmd/server/main.go` accepts **any** channel name and only
  special-cases the `room:` prefix. A personal channel published to by the
  server would be readable by anyone who subscribed to that name, and client
  ids are visible in presence. It would need a new subscribe gate before it
  was safe. (Recorded as a side finding: arbitrary channel subscription is
  harmless today only because nothing is published outside `room:`.)
- Server-side subscriptions (`ConnectReply.Subscriptions`) would avoid the
  gate but add a channel per connection for a feature most rooms never use.
- `Client.Send` has no subscription surface at all: only the server can target
  a connection, and only through `rtc.signal`, which runs every check in 2.4.

The cost: `Client.Send` reaches only connections on the local process. That
is true of every connection today (ADR-0006, single instance, no broker). If
#244 ever adds a broker, signaling moves to server-side personal channels
first; that is a revisit trigger in ADR-0008.

**How room-auth tokens gate it.** There is no separate token for signaling.
The connection token (`connauth`, HS256, `sub`) already gates the connection
when `FEATURE_ROOM_AUTH` is on; the `sub` becomes `client.UserID()`, which
the hub records per `clientId` (`RecordClientUserID`). Every signaling hop is
authorized from that server-held identity and the hub's membership index,
never from anything in the payload. Screen share requires room auth (C7), so
there is always a verified identity behind each `clientId`.

**Server-to-client message shapes** (sent with `Client.Send`, JSON, `type`
discriminated like room publications):

```ts
type ServerMessage =
  | { type: 'rtc.signal'; roomId: string; from: string; payload: SignalPayload }
  | { type: 'screen.viewer'; roomId: string; clientId: string; action: 'join' | 'leave' };
```

`from` is stamped by the server from the caller's `clientId`; a client cannot
claim to be someone else.

### 2.4 `rtc.signal` server checks

In order, cheapest first; each failure is a code-400 UserError unless noted.

1. Feature on (else `ErrorMethodNotFound`).
2. Caller is a member of `roomId` (Authorize, `mutatingMethods`, else
   `ErrorPermissionDenied`).
3. Rate limit: own per-caller bucket `rtcLimiter` (`rtcMethods`), separate
   from chat and transport. Starting values: burst 40, one token per 100ms.
   PR 1 (prototype) measures real message counts and these constants are set
   from that, not from this guess.
4. Raw params size `<= 16 KiB` (checked on `len(data)` before unmarshal). A
   720p screen offer with two transceivers is typically 3 to 6 KiB; the
   prototype confirms the headroom.
5. A share is live in `roomId`.
6. The pair is (broadcaster, admitted viewer) in either direction. Viewer to
   viewer, or to/from a member not admitted, is refused. This is what stops
   `rtc.signal` from becoming an unmoderated direct-message channel that
   bypasses chat moderation and reports.
7. `to` is a member of the same `roomId` (`IsMember(to, roomId)`).
8. `payload` validates against `SignalPayload`:

```ts
type SignalPayload =
  | { kind: 'offer' | 'answer'; sdp: string }            // sdp must start with "v=0"
  | { kind: 'candidates'; candidates: RTCIceCandidateInit[] } // batched, <= 20 per message
  | { kind: 'end-of-candidates' }
  | { kind: 'bye' };
```

   Unknown `kind`, extra top-level fields, or an `sdp` that is not SDP are
   refused. The server treats SDP as opaque beyond that prefix check: it does
   not parse or rewrite it.
9. Resolve `to` with `h.node.Hub().Connections()[to]` and `Send`. A missing
   connection or a `Send` error is "that member is no longer connected", and
   the server runs the viewer-leave path for that id.

`rtc.signal` never touches `RoomState`, never bumps `version`, never persists,
and is never logged with its payload (SDP contains IP addresses; see 7.4).
Logged fields: method, room id, from, to, kind, size.

## 3. State machine

Server state per room, in memory on `Room` (not on `RoomState` except the
published projection in 2.1):

```go
type screenSession struct {
    broadcasterClientID string
    broadcasterUserID   string
    broadcasterName     string
    startedAt           time.Time
    viewers             map[string]struct{} // admitted clientIds, len <= 5
    peakViewers         int                 // for the viewers-per-session histogram
}
// Room gains: screen *screenSession; lastScreen *screenSessionRecord (for reports);
// screenGrants map[string]struct{} (PR 7)
```

```
IDLE  --screen.start (host or grant, private, no share, age ok)-->  LIVE

LIVE  --screen.watch (viewers < 5)-->  LIVE   viewers +1, notify broadcaster
LIVE  --screen.unwatch / viewer disconnect-->  LIVE   viewers -1, notify broadcaster

LIVE  --screen.stop (broadcaster or host)-->  IDLE
LIVE  --broadcaster disconnect / kick / reconnect / rebind-->  IDLE
LIVE  --captured track "ended" (browser Stop sharing), client calls stop-->  IDLE
LIVE  --process restart (state not persisted)-->  IDLE
```

Every transition into or out of LIVE runs through `mutate` (one version bump,
one publication). Viewer changes also run through `mutate` for the
`viewerCount` projection.

| Event | Effect |
|---|---|
| `screen.start` accepted | LIVE; `screen` published; system chat line "<name> started sharing their screen"; `sessions_started_total` +1; log `screen_started` |
| second `screen.start` while LIVE | refused (C2); host may `screen.stop` first |
| late joiner (`room.join` / subscribe while LIVE) | gets `screen` in the join `RoomState`; client calls `screen.watch` (auto when the stage is visible); no special server path |
| `screen.watch` with 5 admitted | refused "full"; client shows full state and retries when a publication shows `viewerCount < maxViewers` (no queue in v1; the race is resolved server-side) |
| viewer `screen.unwatch` or disconnect | removed from set; broadcaster gets `screen.viewer leave` and closes that peer connection; publish |
| viewer kicked (`room.kick`) | kick disconnects it, so the disconnect path above runs |
| broadcaster `screen.stop` | IDLE; publish; system line "<name> stopped sharing"; viewers tear down on the publication |
| host `screen.stop` on another member's share | as above, plus a moderation audit record (`WithModerationAudit`, action `screen_stop`) and system line "The host stopped the screen share" |
| broadcaster disconnects (tab closed, network drop, kicked) | `OnDisconnect` runs `ScreenOnDisconnect(clientID)` **before** `Leave` (same ordering rule as `PromoteOnDisconnect`; it handles both roles, so a disconnecting viewer is removed by the same call); IDLE; publish |
| broadcaster reconnects | centrifuge assigns a new `clientId`, so the old share is already IDLE; client offers "Resume sharing", which calls `screen.start` again with the **same** captured `MediaStreamTrack` if it is still `live` (no second browser prompt) |
| host handoff (#166) while a non-host broadcasts | share continues; the new host gains stop rights; outstanding grants are cleared |
| host handoff because the broadcasting host left | the broadcaster's disconnect already ended the share |
| `room.rebind` (#172) on the broadcaster's anon sub | rebind force-disconnects the old connection, which ends the share; resume as above |
| `room.set_public {public:true}` while LIVE | refused (C6) |
| room already public, `screen.start` | refused (C6) |
| idle eviction | cannot happen while LIVE: the broadcaster is a member, and `evictIdleRooms` skips rooms with members. If it ever does, the in-memory session dies with the room |
| server restart / deploy (ADR-0006 drain) | every share ends; `screen` is not persisted; clients reconnect, see no `screen`, broadcaster gets the resume prompt |
| `FEATURE_SCREENSHARE` turned off | takes effect on restart, so equivalent to the row above; web flag off hides UI and the client stops any local capture |
| `now_playing` is a YouTube video while LIVE | share takes the stage; the YouTube player docks to a visible tile no smaller than 200x200 (YouTube RMF; ADR-0007 keeps it visible). See open question Q4 |

Lock order: screen state lives under `room.mu`. The disconnect hook takes
`memberMu` (read) to resolve the client's rooms, releases it, then calls
`mutate` per room, matching how `PromoteOnDisconnect` already avoids the
`memberMu` then `h.mu` then `room.mu` nesting problem.

## 4. Server design (`apps/server`)

### 4.1 Flag and config

- `FEATURE_SCREENSHARE` (default false), read in `main.go` beside
  `FEATURE_VIDEO`, wired with `WithScreenShare(enabled)`.
- `config.go` gains a fatal check in the existing pattern: screen share on and
  `FEATURE_ROOM_AUTH` off is "FEATURE_SCREENSHARE needs FEATURE_ROOM_AUTH: with
  no host there is no one to control a share". Fail fast at boot rather than
  half-work.
- Log `screenshare_enabled` / `screenshare_disabled` like the other flags.

### 4.2 Files

- `internal/hub/screen.go`: `screenSession`, `screenStart`, `screenStop`,
  `screenWatch`, `screenUnwatch`, `ScreenOnDisconnect`, projection into
  `RoomState.Screen`.
- `internal/hub/signal.go`: `rtcSignal`, payload validation, `rtcLimiter`,
  `sendToClient` (the `Client.Send` wrapper with a test seam like `publishFn`).
- `internal/queue/queue.go`: `Screen *ScreenShareState` on `RoomState`
  (`json:"screen,omitempty"`).
- `hub.go`: dispatch cases, `mutatingMethods`, `hostOnlyMethods` entry for
  `screen.start` (with the grant exception in Authorize, B16 style), the
  persistence strip in `mutate`, the `room.set_public` refusal.
- `cmd/server/main.go`: `ScreenOnDisconnect` in `OnDisconnect` before
  `Leave`.
- `cmd/server/report.go`, `internal/report/report.go`, migration
  `0006_report_kind_broadcast.sql` (widen the `kind` CHECK).

### 4.3 Metrics (`internal/obs/obs.go`)

Naming follows the existing `music_jam_` prefix.

| Series | Type | Source |
|---|---|---|
| `music_jam_screen_sessions_started_total` | counter | `screen.start` accepted |
| `music_jam_screen_sessions_ended_total{reason}` | counter | `reason` from a fixed set: `stopped`, `host_stopped`, `disconnect`, `shutdown` |
| `music_jam_screen_viewers_per_session` | histogram, buckets 0..5 | observed at session end with `peakViewers` |
| `music_jam_screen_watch_rejected_total{reason}` | counter | `full`, `no_share`, `self` |
| `music_jam_rate_limit_rejected_total{method="rtc.signal"}` | existing counter | `rtcLimiter` |
| `music_jam_client_errors_total{name="screen_ice_failed"}` | existing counter | client telemetry (4.4) |
| `music_jam_product_events_total{name="screen_ice_connected"}` | existing counter | client telemetry, the denominator |
| `music_jam_product_events_total{name="screen_capture_denied"}` | existing counter | user cancelled the browser picker |

ICE failure rate = `screen_ice_failed / (screen_ice_failed + screen_ice_connected)`.
This is the number ADR-0008's TURN trigger is written against.

### 4.4 Telemetry allowlist

ICE happens in the browser, so the server learns about it from
`/api/telemetry`. Add `screen_ice_failed` to `telemetryErrors` and
`screen_ice_connected`, `screen_capture_denied` to `telemetryEvents`. The
allowlist is what keeps labels bounded; nothing from the request becomes a
label. The endpoint is unauthenticated, so the rate is advisory: good enough
for a revisit trigger, not for billing.

## 5. Client design (`apps/web`)

### 5.1 Flag

`screenShare: 'COJAM_FEATURE_SCREENSHARE'` in `FEATURE_ENV_VARS`,
`NEXT_PUBLIC_FEATURE_SCREENSHARE` build-time fallback, default false, read via
`useRuntimeFeatures()`. The share button renders only when the flag is on, the
caller is host (or holds a grant), the room is private, and
`navigator.mediaDevices?.getDisplayMedia` exists.

### 5.2 Broadcaster

1. Age gate: if `!hasAffirmedAge()` (`lib/ageGate.ts`, shared with the
   directory gate), show the same affirmation dialog, worded for broadcasting.
   Then `affirmAge()`.
2. Capture:

   ```ts
   navigator.mediaDevices.getDisplayMedia({
     video: { frameRate: { ideal: 15, max: 30 }, height: { max: 720 } },
     audio: true,                     // tab audio in Chromium; ignored where unsupported
     selfBrowserSurface: 'exclude',   // do not offer the CoJam tab itself (echo, recursion)
     surfaceSwitching: 'include',
     systemAudio: 'include',
   });
   ```

   Chromium-only hints are ignored elsewhere. Audio availability by platform:
   Chromium shares tab audio everywhere and system audio on Windows and
   ChromeOS; Firefox and Safari return no audio track. The UI says "audio not
   available on this browser" instead of failing. A cancelled picker posts
   `screen_capture_denied` and returns to idle silently.
3. Set `track.contentHint = 'detail'` (text and UI stay sharp); a toggle sets
   `'motion'` for video content.
4. `screen.start { roomId, ageAffirmed: true }`. On refusal, stop the tracks.
5. On each `screen.viewer join`: create one `RTCPeerConnection` for that viewer
   (C1) with `iceServers` from 5.4, `addTrack` each captured track (one
   capture, many senders), cap the encoder with
   `sender.setParameters({ encodings: [{ maxBitrate: 1_200_000 }] })` and
   `degradationPreference: 'maintain-resolution'`, `createOffer`,
   `setLocalDescription`, send `{kind:'offer'}`. Trickle ICE, batching
   candidates in 100ms windows into one `{kind:'candidates'}` message.
6. On `screen.viewer leave` or `bye`: close and drop that peer connection.
7. On the captured video track's `ended` event (the browser's own "Stop
   sharing" bar): call `screen.stop` and close everything.
8. On a publication where `screen` is absent or `broadcasterId` is not this
   connection: close all peer connections; if the track is still `live`, offer
   "Resume sharing" (state machine, reconnect row).

### 5.3 Viewer

1. On a `RoomState` with `screen` and `broadcasterId !== me`, and the stage
   visible: `screen.watch`. On "full", show "The share is full (5 of 5).
   You'll join when a spot opens" and retry on the next publication with
   `viewerCount < maxViewers`.
2. Wait for the broadcaster's offer: create the `RTCPeerConnection`,
   `setRemoteDescription`, `createAnswer`, send `{kind:'answer'}`, trickle
   candidates.
3. `ontrack`: attach the stream to a `<video autoplay playsInline>` inside
   `<Stage>` (`app/room/components/Stage.tsx`, built for this). Start muted to
   satisfy autoplay policy; an overlay "Tap for sound" unmutes on gesture.
4. Connection state: `iceConnectionState === 'failed'` (or no `connected`
   within 15s) shows "Couldn't connect to the share. Your network or the
   sharer's blocks direct connections, and CoJam doesn't run a relay yet."
   One automatic retry with `restartIce()`, then telemetry
   `screen_ice_failed` and stop. On `connected`, telemetry
   `screen_ice_connected` once per session.
5. Leaving the room, hiding the stage, or the share ending: `screen.unwatch`
   (best-effort; disconnect covers it) and close.

### 5.4 ICE servers

`[{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }]`,
overridable through a runtime `COJAM_STUN_URLS` in `/env.js`. No TURN entries
(C5). Note that STUN requests disclose the client's address to the STUN
operator; that belongs in the privacy policy (#253).

### 5.5 Renegotiation

- Broadcaster switches surface through `surfaceSwitching`: the track is the
  same object, no renegotiation.
- Broadcaster picks a new source with "Change source": `getDisplayMedia` again,
  then `sender.replaceTrack(newTrack)` on every peer connection. No SDP round
  trip unless the new capture adds or drops audio; in that case renegotiate
  per peer (`negotiationneeded`, broadcaster as the only offerer, so no glare
  handling is needed in v1).
- A viewer never offers. One offerer per pair keeps the perfect-negotiation
  machinery out of v1.

### 5.6 Reporting

Viewers and every other member see "Report this broadcast" on the stage
overlay while a share is live and for 10 minutes after it ends. It posts
`kind: 'broadcast'` to the existing `/api/report`. The client sends only the
room id and the reason; the server stamps the subject (7.3).

## 6. Failure modes

| Failure | Detection | User sees | Server effect |
|---|---|---|---|
| Symmetric NAT / CGNAT on either side | ICE `failed` or 15s timeout | the relay message in 5.3.4 | none; telemetry `screen_ice_failed` |
| Broadcaster uplink saturated | rising `qualityLimitationReason: 'bandwidth'`, falling `framesPerSecond` in `getStats` | broadcaster: "Your connection is struggling; fewer viewers will help" | none |
| Broadcaster CPU saturated | `qualityLimitationReason: 'cpu'` | same hint, CPU wording | none |
| Browser picker cancelled | `NotAllowedError` | nothing, back to idle | telemetry `screen_capture_denied` |
| `getDisplayMedia` missing (most mobile) | feature detect | no share button; watching still works | none |
| Signaling rate limited | UserError | broadcaster: retry with backoff; candidate batches coalesce | `rate_limit_rejected{method="rtc.signal"}` |
| Target vanished mid-handshake | `Send` miss | viewer path ends | viewer-leave path |
| Server restart / deploy | reconnect | "Share ended (server restarted). Resume?" | session ended, `reason="shutdown"` |
| DRM content shared | black frames on the viewer side | black video, as in every capture product | none |
| Duplicate room audio | broadcaster shares a tab playing the room's music | viewers hear the track twice, out of sync | none; `selfBrowserSurface: 'exclude'` removes the common case, the UI warns when the shared tab is audible |
| Autoplay blocked on viewer | `play()` rejects | muted video with "Tap for sound" | none |
| Viewer tab backgrounded | `visibilitychange` | video keeps decoding; no action in v1 | none |

## 7. Safety (ECA Digital, Lei 15.211), mapped to duties

The duties below are the ones `259-eca-minor-safety.md` identified for CoJam,
read against the live-transmission surface the ANPD acted on in August 2026.

### 7.1 Reduce exposure of minors to strangers' live transmissions

- **Private rooms only (C6).** A share can never appear in the public
  directory and a room cannot be listed while sharing. The directory is the
  stranger-to-stranger surface; invite links are, by the #259 3.1 reasoning,
  people who know each other.
- **Residual risk, stated:** a private room's link can be posted publicly, and
  that room is then strangers with no directory gate. v1 does not solve this;
  the 5-viewer cap and host control bound it. Q2 asks whether broadcasting
  should additionally require that every viewer arrived by invite and not by
  a link seen more than N times; no such signal exists today.

### 7.2 Age signal before the riskier action

- **Age affirmation before broadcasting (C8)**, reusing `lib/ageGate.ts` and
  its provisional `MINIMUM_AGE` (16, pending #253). Self-declared, per
  browser, no date of birth stored: the same proportionality call #259 made.
  `screen.start` requires `ageAffirmed: true` so the server log records that
  the affirmation was made for this session. Neither is verification.
- **Viewing is not gated** in v1, matching the invite-link rule. Q1 asks
  whether it should be.

### 7.3 A reporting route that works for guests

- **`kind: 'broadcast'`** on the existing `/api/report` (guest-accessible,
  rate-limited, body-capped, rune-safe, #286). Migration widens the CHECK to
  `('message', 'member', 'room', 'broadcast')`.
- **The subject is server-stamped.** For `broadcast` the handler ignores the
  client's `subjectId` and `content` and fills them from the hub: the live
  session for that room, or `lastScreen` if a share ended in the last 10
  minutes. `content` becomes a JSON snapshot: broadcaster user id and display
  name, started and ended times, peak viewers. A report with no session in
  that window is rejected (400). The reporter's own `reason` is kept as typed.
- **Nothing of what was on screen is retained.** No frames, thumbnails or
  recordings (out of v1). The evidence is weaker than a chat report; the
  standing exposure is much smaller. Q3 asks whether a reporter-side snapshot
  is worth its retention cost.

### 7.4 Act fast, without needing to be the bad actor's moderator

- **Host stop without kick** (`screen.stop` on any share), audited through the
  existing moderation trail (#286).
- **Kick ends a share** as a side effect of disconnect.
- **Operator kill switch:** web flag off hides it in about a minute through
  `/env.js`; server flag off plus a restart ends every live share.
- **Gap, stated:** there is no operator action that stops one specific live
  share in one room without a restart. ADR-0008 lists that as a precondition
  for public rooms; for private rooms v1 accepts it. Q5.

### 7.5 Data minimization (LGPD, same authority)

- SDP and candidates carry public IP addresses. They are never logged, never
  persisted, and pass through memory only for the length of one `Send`.
- Peers learn each other's public IP (ADR-0008, Consequences). Disclosed in
  the privacy policy (#253) and one more reason for private-only.
- Structured logs `screen_started` / `screen_stopped` carry room id, broadcaster
  user id, times and peak viewers: what an investigation needs ("who broadcast
  in room X at time T") and nothing about content.

## 8. One-hour prototype (PR 1, throwaway)

Required by the repo's no-big-bang rule before any production code. Not
merged, not on `main`.

**Shape.** A scratch directory outside the repo
(`/Volumes/External HD/Desenvolvimento/.worktrees/cojam-screen-proto/`): a
Go WebSocket relay of about 60 lines that forwards JSON between named peers in
one room, plus one static HTML page with a "share" and a "watch" mode. Same
`getDisplayMedia` options, ICE servers, bitrate cap and candidate batching as
section 5, so what is measured is what ships. Exposed through a temporary
`cloudflared` quick tunnel so a phone off the home network can join. Torn down
after.

**Topology under test.** Mesh 1:2. One broadcaster (desktop Chrome, home
fibre), viewer A (second desktop on the same LAN), viewer B (phone on 4G
mobile data, Wi-Fi off: the CGNAT case).

**Measurements.**

1. Time from viewer join to first decoded frame (`requestVideoFrameCallback`).
2. Broadcaster `getStats`: `bytesSent` per sender over 60s, `qualityLimitationReason`.
3. Signaling messages per viewer join, by kind, and the largest message size.
4. Selected candidate pair type for each viewer (`host`, `srflx`, `prflx`).
5. Tab audio arrives on viewer A.
6. Late join: viewer B joins 30s after viewer A without disturbing A.
7. "Change source" via `replaceTrack` without renegotiation.

**Pass** (all of):

- Viewer A shows frames within 3s; viewer B within 5s.
- Per-viewer send rate stays at or under the 1.2 Mbps cap, and two viewers cost
  about twice one (linear, as the cost model assumes).
- At most 30 signaling messages per viewer join with 100ms batching; largest
  message under 12 KiB (so the 16 KiB cap and the burst-40 limiter hold).
- Late join and `replaceTrack` both work with no renegotiation on A.
- Tab audio audible on A.

**Fail, and what each failure means:**

- Viewer B cannot connect over 4G via STUN: the TURN question is not a
  "10 to 20%" edge case for a mobile-first Brazilian audience. Stop and take
  that to the owner before PR 2, because it changes whether v1 is worth
  shipping without TURN.
- Signaling exceeds the budget: resize the limiter and cap, re-run.
- Send rate is not linear, or the broadcaster hits CPU limits at two viewers:
  revisit the cap of 5 before PR 2.

**Output.** A comment on #310 with the numbers, and the constants in 2.4 and
5.2 updated in a follow-up commit to this spec.

## 9. Test plan

### 9.1 Server unit (`internal/hub/hub_screen_test.go`, `hub_signal_test.go`)

Using the existing `testClient`, `publishFn` seam and a new `sendFn` seam.

- flag off: every new RPC is `ErrorMethodNotFound`
- config: screen share on with room auth off is fatal
- `screen.start`: non-host denied; host ok; `ageAffirmed` missing refused;
  public room refused; second start refused; grant consumed once (PR 7)
- `room.set_public {public:true}` refused while live; `{public:false}` allowed
- race: concurrent `screen.start` and `room.set_public` (run with `-race`,
  100 iterations): never both accepted
- `screen.watch`: cap at 5, sixth refused with `reason="full"`, idempotent
  re-watch, broadcaster cannot watch self, no share refused
- `rtc.signal`: non-member caller, non-member `to`, viewer to viewer, to a
  non-admitted member, no live share, oversized (16 KiB + 1), bad `kind`,
  extra fields, non-SDP `sdp`, rate limit, `from` is stamped (a forged `from`
  in params is ignored)
- disconnect: viewer leave notifies broadcaster; broadcaster leave ends the
  share and publishes; kick of each
- persistence: `store.Save` never receives a non-nil `Screen`; a reloaded room
  has no `screen`
- metrics: started, ended by reason, viewers histogram on end
- reports: `broadcast` stamps subject from the live session and from
  `lastScreen` within 10 minutes, rejects outside it, ignores client
  `subjectId`/`content`

### 9.2 Web unit (Vitest)

- peer manager (`lib/screenShare.ts`) with a fake `RTCPeerConnection`: one PC
  per viewer, close on leave, candidate batching window, `replaceTrack` on all
  senders, cleanup on publication without `screen`
- age gate shown before `getDisplayMedia`, and not again once affirmed
- button hidden: flag off, non-host, public room, no `getDisplayMedia`
- viewer states: connecting, full, ICE failed copy, tap for sound

### 9.3 E2E (Playwright, `e2e/screen-share.spec.ts`)

Config: server env `FEATURE_SCREENSHARE: 'on'` beside the existing flags; a
Chromium project with

```ts
launchOptions: { args: [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--auto-select-desktop-capture-source=Entire screen',
  '--disable-features=WebRtcHideLocalIpsWithMdns',
] }
```

The last flag keeps host candidates as plain loopback addresses so CI
containers do not depend on mDNS resolution. STUN is unreachable in CI, which
is fine: same-host peers connect over host candidates.

**Verify in PR 1 that the fake-UI flag auto-accepts `getDisplayMedia` in the
headless Chromium Playwright ships.** If it does not, the fallback is an
`addInitScript` that replaces `getDisplayMedia` with a
`canvas.captureStream(15)` source. Both give the viewer a real decoded track,
which is what the assertion needs.

Scenarios:

1. **Acceptance (from the issue):** host shares in a private room; two viewer
   contexts each receive a track. Assert on each viewer: `<video>` has a live
   video track, `videoWidth > 0`, and `getStats` `inbound-rtp`
   `framesDecoded` increases over 2s.
2. **Acceptance:** in a public room, `screen.start` is refused and the button
   is absent.
3. `room.set_public` while live is refused with the expected message.
4. Broadcaster closes the tab: both viewers return to the normal stage within
   5s.
5. Host stops a non-host share (needs the PR 7 grant; skip until then).
6. Selected candidate pair type is never `relay` (C4 regression guard).

The sixth-viewer cap is covered in 9.1, not E2E: seven browser contexts are
slow and the server is the enforcement point.

## 10. Task breakdown (small PRs)

Each PR is independently reviewable and leaves `main` shippable with the flag
off.

| PR | Scope | Size |
|---|---|---|
| 1 | Prototype (section 8), throwaway, not merged. Results on #310, constants updated here | 1h |
| 2 | Protocol and flags only: `protocol.md`, `protocol.ts` types, `FEATURE_SCREENSHARE` + config fatal, `COJAM_FEATURE_SCREENSHARE` in `features.ts` and `/env.js`. No behaviour | S |
| 3 | Server session: `screen.start/stop/watch/unwatch`, `RoomState.screen`, persistence strip, `set_public` refusal, disconnect hook, system chat lines, metrics. Tests 9.1 (minus signal, reports) | M |
| 4 | Server signaling: `rtc.signal`, payload validation, `rtcLimiter`, `Client.Send` seam, `realtime.ts` `message` handler. Tests 9.1 signal | M |
| 5 | Reports: `broadcast` kind, migration 0006, server-stamped subject, `lastScreen`; telemetry allowlist additions | S |
| 6 | Web: `lib/screenShare.ts` peer manager, broadcaster and viewer flows, Stage integration, YouTube dock tile, age gate, report button. Tests 9.2 | M/L (split UI from the peer manager if it passes ~400 lines) |
| 7 | Optional: `screen.allow` host grant, plus E2E scenario 5 | S |
| 8 | E2E `screen-share.spec.ts` and Playwright config | S |
| 9 | Rollout: terms clause confirmed in #253, metrics scraped and a Grafana panel for ICE failure rate, staging on, then production on for a named test room set; runbook entry (local `docs/runbooks/`) | S |

PR 3 and PR 4 can run in parallel worktrees once PR 2 lands. PR 6 depends on
both. PR 9 does not start until #253's terms clause is merged.

## 11. Acceptance criteria

- Two viewers receive the host's screen in a private room (E2E 1).
- A public room refuses `screen.start`; a live share refuses
  `room.set_public {public:true}` (E2E 2, 3; unit race test).
- The sixth `screen.watch` is refused server-side (unit).
- `rtc.signal` refuses every case in 2.4 (unit).
- No `screen` ever reaches the store (unit).
- No TURN entry in the client ICE config; no relay candidate pair in E2E.
- Broadcast reports are server-stamped and work for guests.
- All series in 4.3 exist and are scraped before the production flag flips.
- With both flags off, nothing changes for existing rooms.
- The server transmits no media bytes. Assert it explicitly in review, as #258
  did.

## 12. Open questions

- **Q1.** Should viewing (not only broadcasting) require the age affirmation?
  Invite-link joins are ungated by the #259 decision; a live screen is a
  stronger surface than a queue.
- **Q2.** Is "private" enough when a link can be posted publicly? Is there a
  cheap signal (distinct joiners per hour above a threshold) that should
  disable `screen.start` for a room?
- **Q3.** Should a broadcast report capture a single reporter-side frame?
  Better evidence, but it is user-generated image data CoJam then retains,
  possibly of a minor.
- **Q4.** YouTube video playing when a share starts: dock the player in a
  200x200 tile (this spec), or refuse `screen.start` until the video is paused?
- **Q5.** Is a per-room operator stop (without restart) required before the
  production flag flips, even for private rooms?
- **Q6.** `screen.allow` (host grant to another member): ship in v1 (PR 7) or
  drop until asked for?
