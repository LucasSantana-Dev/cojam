# 310: Screen share v1 (WebRTC P2P mesh, private rooms only)

Issue: [#310](https://github.com/LucasSantana-Dev/cojam/issues/310)
Status: spec, critic verdict "approve with changes" applied 2026-10-07
Date: 2026-10-07
Decision record: ADR-0008 (`docs/adr/0008-screen-share-webrtc-mesh.md`, local
only by repo convention; the binding constraints and revisit triggers are
restated in section 1 so this file stands alone)
Depends on: #258 (stage layout, merged in #315), #259 (reports, age gate,
moderation trail), #253 (terms and privacy policy), PR #323 (monitored report
destination, `REPORT_WEBHOOK_URL`), branch `fix/server-hardening` (fail-closed
host gate, server-side room id validation, per-IP limit on the token endpoint)

> **Not legal advice.** Section 7 maps the mechanism to the duties discussed in
> `259-eca-minor-safety.md`. Whether that mapping is sufficient is a question
> for the legal review #259 and #253 already require, and that review is a
> rollout gate (section 10, PR 9).

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

Context on Brazil: on 2026-08-12 the **ANPD** (Agência Nacional de Proteção
de Dados), not the AGU, ordered Discord, as a preventive measure under ECA
Digital (Lei 15.211, arts. 6 II and III, 10, 17, 28, 29), to suspend its
livestream feature. Discord and Discord voice stayed up. Source:
<https://agenciagov.ebc.com.br/noticias/202608/em-medida-preventiva-anpd-determina-que-discord-suspenda-transmissoes-ao-vivo>.
Screen share to a small private group is the closest thing CoJam can offer to
the suspended feature, which is also why it carries the most ECA Digital
exposure of anything in the backlog.

## 1. Binding v1 constraints

From ADR-0008. Any change needs an ADR amendment and a critic pass.

| # | Constraint | Enforced where |
|---|---|---|
| C1 | P2P mesh, one `RTCPeerConnection` per viewer, broadcaster-initiated | client; server only relays |
| C2 | One broadcaster per room | `screen.start` in the room mutation |
| C3 | At most 5 viewers per share, one slot per `userID`, admission is an explicit viewer action | `screen.watch`, server-side |
| C4 | Server relays SDP/ICE only, never media | no media code server-side; review assertion |
| C5 | Public STUN only; no TURN, no SFU until revenue (#262) | client ICE config |
| C6 | Private rooms only: `screen.start` refused when `public` or when the room id is not in the current generator format; `room.set_public {public:true}` refused while live | inside the room mutation closure |
| C7 | Host-controlled, fail closed; requires `FEATURE_ROOM_AUTH` in every environment | mutation closure + boot check |
| C8 | Age affirmation before broadcasting | client gate + `ageAffirmed` param, recorded in the trail |
| C9 | Report kind `broadcast`, subject resolved by the server from the durable trail, never rejected | `/api/report` |
| C10 | `FEATURE_SCREENSHARE` / `COJAM_FEATURE_SCREENSHARE`, default off; optional `SCREENSHARE_ROOM_ALLOWLIST` | server config, `features.ts` |
| C11 | Prometheus series exist and are scraped before prod rollout | rollout gate |
| C12 | Host can lock viewers and refuse a person for the session (kick is not a ban) | `screen.lock`, `screen.refuse` |
| C13 | Persistent "transmissão não moderada" notice while live; rights notice at share start | client |

**Out of v1:** camera, voice, recording, multiple broadcasters,
viewer-to-viewer links, desktop app, simulcast, TURN, SFU, shares in public
rooms, a viewer waiting queue.

### 1.1 Revisit triggers (from ADR-0008)

- **TURN:** the measured ICE failure rate (section 4.3) stays above **15%**
  over two consecutive weeks with **at least 200 attempts**, **and** #262 has
  produced recurring revenue that covers projected relay egress at that rate.
  Either half alone is not enough. TURN breaks the server-side property and
  needs its own ADR.
- **SFU or a higher viewer cap:** more than 25% of sessions hit the 5-viewer
  cap over a month, or broadcaster telemetry shows uplink saturation at 3 or
  more viewers, **and** the revenue condition above. The SFU ADR must
  re-evaluate the licensing exposure of relayed audio.
- **Public rooms:** only after all of (a) the legal review under #259 and #253
  has concluded and explicitly covers live transmission to strangers, (b)
  account sign-in works in production and is required to broadcast in a
  public room, (c) reports reach a monitored destination with a measured
  response time, (d) the operator can stop one live share without a restart.
- **Horizontal scale (#244):** signaling depends on every connection living on
  one process. A broker means moving signaling to server-side personal
  channels first.
- **Regulatory:** any ANPD action or guidance on live transmission in small or
  private groups, or enforcement against a comparable product for
  screen-shared content.

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
  locked: boolean;            // host closed admission (C12)
};

type RoomState = {
  // ...existing fields
  screen?: ScreenShareState;  // present only while a share is live
};
```

**Why `clientId`, not `userId`, for the broadcaster.** Signaling targets a
connection, not a person: one account in two tabs is two connections.
Presence is already keyed by `clientId` and `room.kick` already takes one, so
the client can map a broadcaster to a presence entry and the host can kick
them with ids it already has. The server keeps the broadcaster's `userId`
internally for host checks, takeover (3), refusals, reports and the trail.
Viewer **slots** are keyed by `userId` (C3), so one person in two tabs holds
one slot.

**`screen` is never persisted.** It describes live connections that die with
the process. `mutate` already deep-copies state before `store.Save`; the copy
gets `Screen = nil` before the save, and `GetOrCreateRoom` clears it on load
as a second guard. A start, stop, lock or viewer change still bumps `version`
(version-guarded clients drop unbumped publications), which costs one store
write per transition, bounded at roughly a dozen per session.

### 2.2 RPCs

| method | params | result | who |
|---|---|---|---|
| `screen.start` | `{ roomId, ageAffirmed: true }` | `RoomState` | host, a grant holder, or the same `userId` as a dropped broadcaster (takeover) |
| `screen.stop` | `{ roomId }` | `RoomState` | the broadcaster, or the host (any share) |
| `screen.watch` | `{ roomId }` | `{ broadcasterId }` | any member except the broadcaster, not refused, share not locked |
| `screen.unwatch` | `{ roomId }` | `{}` | an admitted viewer (always allowed: anyone can end their own viewing) |
| `screen.lock` | `{ roomId, locked: boolean }` | `RoomState` | host or broadcaster |
| `screen.refuse` | `{ roomId, clientId }` | `{}` | host or broadcaster |
| `rtc.signal` | `{ roomId, to: string, payload: SignalPayload }` | `{}` | broadcaster or an admitted viewer |
| `screen.allow` (PR 7, optional) | `{ roomId, clientId }` | `{}` | host |

**Host checks run inside the `mutate` closure, fail closed.** The existing
`Authorize` host gate reads `GetHostUserID`, which returns `""` for a room not
loaded in memory and so fails open; `fix/server-hardening` is changing that
gate to fail closed. Screen share does not depend on that fix landing first:
`screen.start`, the host branch of `screen.stop`, `screen.lock`,
`screen.refuse` and `screen.allow` check, inside the closure and under
`room.mu`, that `s.HostUserID != "" && s.HostUserID == userID` (or that the
caller holds a grant, or is the broadcaster where the table allows it). An
empty `HostUserID` is a refusal, never "everyone is host". The defensive
"needs room auth" check is this `HostUserID` test, not a read of the feature
flag. `screen.start` is therefore **not** added to `hostOnlyMethods`, so the
grant and takeover paths are not pre-empted by `ErrorPermissionDenied`.

`screen.start` refusals, each a code-400 UserError:

- no host, or caller is neither host, grant holder nor takeover candidate:
  "only the host can start a screen share"
- room id does not match the generator format (12 uppercase base36 chars,
  `apps/web/lib/roomId.ts`): "screen share needs a newer room link". Private
  means unguessable: a pre-#180 6-char id is guessable (`docs/protocol.md`,
  Trust model), so it cannot host a share. `fix/server-hardening` adds general
  server-side id validation; this check is specific and stricter.
- `SCREENSHARE_ROOM_ALLOWLIST` set and the room not in it: "screen share is not
  available in this room yet"
- `ageAffirmed !== true`: "confirm your age to share your screen"
- room `public == true`: "screen share is only available in private rooms"
- a share already live by a different `userId`: "<name> is already sharing"

`room.set_public` gains one refusal: `public: true` while `screen != nil` is
"stop the screen share before making the room public". `public: false` is
always allowed. Both checks live inside the `mutate` closure, so they
serialize and cannot both win.

`screen.watch` admits the caller (C3). Refusals: no live share ("nothing is
being shared"), caller is the broadcaster, caller's `userId` is on the
session refusal list or the share is locked ("the sharer isn't admitting
viewers"), set is full ("the share is full (5 viewers)"). If the caller's
`userId` already holds a slot from another connection, the slot moves to the
new connection and the old one gets `screen.viewer leave` handling. On
admission the server bumps `viewerCount`, publishes, and notifies the
broadcaster (2.3) so it opens the peer connection.

`screen.refuse` adds the target connection's `userId` to the session's refusal
list and runs the viewer-leave path for every connection of that `userId`.
The list lives on the session and dies with it.

**Kick is not a ban, and identity is not proof of a person.** Connection
identities are server-signed tokens whose `sub` anyone can obtain fresh from
`/api/connection-token` (that endpoint gains a per-IP limit in
`fix/server-hardening`, which slows minting but does not make it identity).
A kicked or refused person can return with a new `sub`. `screen.lock` is the
control that actually holds: once the people who should watch are in, the host
or broadcaster closes admission.

### 2.3 Delivering to a single client

Verified against the vendored code:

- Server `github.com/centrifugal/centrifuge v0.38.0` has
  `func (c *Client) Send(data []byte) error` (`client.go:947`): an
  asynchronous message written straight to the connection.
- Client `centrifuge` 5.7.x exposes it as the `message` event on the
  `Centrifuge` instance (`types.d.ts:30`). `lib/realtime.ts` currently listens
  only for `publication` on the room subscription; it gains one
  `centrifuge.on('message', ...)` handler.

**Decision: `Client.Send` through a hub-owned client map, not a personal
channel.**

- `OnSubscribe` in `cmd/server/main.go` accepts **any** channel name and only
  special-cases `room:`. A personal channel (`rtc:<clientId>`) would be
  readable by anyone who subscribed to that name, and client ids are visible
  in presence. (Side finding: arbitrary subscription is harmless today only
  because nothing is published outside `room:`.)
- Server-side subscriptions would avoid that gate but add a channel per
  connection for a feature most rooms never use.
- `Client.Send` has no subscription surface: only the server targets a
  connection, and only after the checks in 2.4.

**Client lookup.** `roomKick` resolves a connection with
`h.node.Hub().Connections()[id]`, which copies the whole connection map under
a lock on every call. That is fine for a rare kick and wrong for a per-signal
path. The hub keeps its own `clients map[string]*centrifuge.Client`, filled in
`RegisterClient` and removed on disconnect, behind a `sendToClient(clientID,
data)` seam (tests replace it, like `publishFn`).

This reaches only connections on the local process, true of every connection
today (ADR-0006). A broker (#244) moves signaling to server-side personal
channels first (1.1).

**What gates it.** The connection token (`connauth`, HS256, `sub`) gates the
connection when `FEATURE_ROOM_AUTH` is on, and `sub` becomes
`client.UserID()`. Every signaling hop is authorized from that server-held
identity and the hub's membership and session state, never from the payload.
That identity is a stable, server-signed handle, not a verified person (2.2).

**Server-to-client messages** (`Client.Send`, JSON, `type` discriminated):

```ts
type ServerMessage =
  | { type: 'rtc.signal'; roomId: string; from: string; payload: SignalPayload }
  | { type: 'screen.viewer'; roomId: string; clientId: string; action: 'join' | 'leave' };
```

`from` is stamped from the caller's `clientId`.

### 2.4 `rtc.signal` server checks

In order, cheapest first; each failure is a code-400 UserError unless noted.

1. Feature on (else `ErrorMethodNotFound`).
2. Caller is a member of `roomId` (else `ErrorPermissionDenied`).
3. Rate limit: own per-caller bucket `rtcLimiter`. Sized for the broadcaster
   side of **five simultaneous joins**: 5 offers, about 5 candidate batches
   each, 5 end-of-candidates, so about 35 messages inside two seconds.
   Starting values: burst 60, one token per 100ms. The prototype (8)
   measures the real count and these are set from it.
4. Raw params size `<= 16 KiB`, checked on `len(data)` before unmarshal.
5. A share is live in `roomId`.
6. The pair is (broadcaster, admitted viewer). Viewer to viewer, or to/from a
   member not admitted, is refused. This stops `rtc.signal` from becoming an
   unmoderated direct-message channel.
7. **Direction:** `offer` only broadcaster to viewer; `answer` only viewer to
   broadcaster; `candidates`, `end-of-candidates` and `bye` either way.
8. `to` is a member of the same `roomId`.
9. `payload` validates:

```ts
type SignalPayload =
  | { kind: 'offer' | 'answer'; sdp: string }                 // sdp must start with "v=0"
  | { kind: 'candidates'; candidates: RTCIceCandidateInit[] }  // <= 20 per message
  | { kind: 'end-of-candidates' }
  | { kind: 'bye' };
```

   Unknown `kind`, extra fields, or a non-SDP `sdp` are refused. SDP is opaque
   beyond that prefix: never parsed or rewritten.
10. `sendToClient(to, ...)`. A missing client or a send error is "that member
    is no longer connected" and runs the viewer-leave path for that id.

`rtc.signal` never touches `RoomState`, never persists, and is never logged
with its payload (SDP carries IP addresses, 7.5). Logged: method, room, from,
to, kind, size.

## 3. State machine

Server state, in memory on `Room` (only the projection in 2.1 is published):

```go
type screenSession struct {
    broadcasterClientID string
    broadcasterUserID   string
    broadcasterName     string
    ageAffirmed         bool
    startedAt           time.Time
    viewers             map[string]string   // userID -> clientID, len <= 5
    refused             map[string]struct{} // userIDs refused for this session
    locked              bool
    peakViewers         int
}
// Room gains: screen *screenSession; screenGrants map[string]struct{} (PR 7)
// Hub gains:  screenByClient map[string]string  // clientID -> roomID, for both roles
```

**`screenByClient` is the cleanup index, not the membership index.** The
critic found that `roomKick` calls `h.leaveRoom` (`moderation.go:111`) before
`Disconnect` (`moderation.go:114`), and `room.rebind` reaches the same path
(`rebind.go:163`). A disconnect hook that looked up rooms through membership
would already have lost the kicked room and leave a dead share live. So:

- `roomKick` runs `screenLeave(roomID, clientID)` **before** `leaveRoom`.
- `ScreenOnDisconnect(clientID)` resolves rooms from `screenByClient`, which
  only screen RPCs write and only `screenLeave` clears. It runs first in
  `OnDisconnect`, before `PromoteOnDisconnect` and `Leave`.
- Both paths are idempotent; whichever runs second is a no-op.
- Clients close every `RTCPeerConnection` and drop share UI on **any**
  centrifuge disconnect, without waiting for a publication. A kicked viewer
  is cut off by its own client as well as by the broadcaster.

```
IDLE  --screen.start (host/grant, private, valid id, no share, age ok)-->  LIVE

LIVE  --screen.watch (slots < 5, not locked, not refused)-->  LIVE   +1, notify broadcaster
LIVE  --screen.unwatch / viewer disconnect / kick / refuse-->  LIVE   -1, notify broadcaster
LIVE  --screen.lock-->  LIVE   admission closed or reopened

LIVE  --screen.start by the same userID from a new connection-->  LIVE   takeover, viewers reset
LIVE  --screen.stop (broadcaster or host)-->  IDLE
LIVE  --broadcaster disconnect / kick / rebind-->  IDLE
LIVE  --captured track "ended" (browser Stop sharing), client calls stop-->  IDLE
LIVE  --process restart (state not persisted)-->  IDLE
```

Every transition runs through `mutate`. Every start and stop is written to
the moderation trail (4.4).

| Event | Effect |
|---|---|
| `screen.start` accepted | LIVE; publish; system line "<name> started sharing their screen"; trail `screen.start`; `sessions_started_total` +1 |
| `screen.start` while LIVE, different `userId` | refused (C2); host may `screen.stop` first |
| `screen.start` while LIVE, **same `userId`** as the broadcaster (dropped connection whose disconnect has not been detected yet, or a reload) | takeover: old session ends with `reason="takeover"`, old connection's peers torn down, new session starts with no viewers; viewers re-watch. Avoids being locked out of your own share for the ping timeout |
| late joiner while LIVE | gets `screen` in the join `RoomState`; client shows the "Assistir" card (5.3); nothing automatic |
| `screen.watch`, all 5 slots taken | refused "full"; card shows "5 of 5" and enables again when a publication shows a free slot. No queue |
| `screen.watch`, same `userId` already admitted elsewhere | slot moves to the new connection |
| viewer `screen.unwatch` | removed; broadcaster closes that peer; publish. Always allowed |
| viewer disconnect, kick, rebind | `screenLeave` before `leaveRoom` (kick, rebind) or `ScreenOnDisconnect` (disconnect); as above |
| `screen.refuse` | all of the target's connections removed; their `userId` cannot re-watch this session |
| `screen.lock {locked:true}` | new `screen.watch` refused; admitted viewers stay |
| broadcaster `screen.stop` | IDLE; publish; system line; trail `screen.stop` |
| host stops another member's share | as above, trail action `screen.host_stop`, system line "The host stopped the screen share" |
| broadcaster disconnects, is kicked or rebound | `screenLeave` / `ScreenOnDisconnect`; IDLE; publish; trail `screen.stop` with `reason` |
| broadcaster reconnects | new `clientId`; if the old session is already IDLE, "Resume sharing" calls `screen.start` with the **same** captured track if still `live` (no second browser prompt); if not yet IDLE, takeover |
| host handoff while a non-host broadcasts | share continues; new host gains stop, lock and refuse; outstanding grants cleared |
| `room.set_public {public:true}` while LIVE | refused (C6) |
| idle eviction | cannot happen while LIVE (the broadcaster is a member) |
| server restart / deploy (ADR-0006 drain) | every share ends; no `screen` persisted; broadcaster sees "Resume sharing" |
| `FEATURE_SCREENSHARE` off | effective on restart, so as above; web flag off hides UI and stops local capture |
| YouTube video playing while LIVE | share takes the stage; YouTube player docks to a visible tile of at least 200x200 (RMF; ADR-0007). Q4 |

Lock order: screen state lives under `room.mu`; `screenByClient` has its own
mutex, never held across `mutate`.

## 4. Server design (`apps/server`)

### 4.1 Flag and config

- `FEATURE_SCREENSHARE` (default false), read beside `FEATURE_VIDEO`, wired with
  `WithScreenShare(enabled)`.
- **Boot check in every environment.** `validateProdConfig` returns nothing
  outside `APP_ENV=production` (`config.go`), so this check does **not** go
  there. A separate always-on check in `main.go` exits when screen share is on
  and `FEATURE_ROOM_AUTH` is off: "FEATURE_SCREENSHARE needs FEATURE_ROOM_AUTH:
  with no host there is no one to control a share". Dev and e2e get the same
  failure as production.
- `SCREENSHARE_ROOM_ALLOWLIST` (optional, comma-separated room ids). Unset means
  every eligible private room; set means only those. It exists for the
  named-test-rooms stage of rollout (PR 9) and is removed from the
  environment, not the code, when that stage ends.
- Log `screenshare_enabled` / `screenshare_disabled`, and the allowlist size.

### 4.2 Files

- `internal/hub/screen.go`: session, `screenStart/Stop/Watch/Unwatch/Lock/Refuse`,
  `screenLeave`, `ScreenOnDisconnect`, `screenByClient`, projection.
- `internal/hub/signal.go`: `rtcSignal`, payload and direction validation,
  `rtcLimiter`.
- `internal/hub/clients.go` (PR 2): the hub client map and `sendToClient` seam.
- `internal/queue/queue.go`: `Screen *ScreenShareState` (`json:"screen,omitempty"`).
- `hub.go`: dispatch cases, `mutatingMethods`, persistence strip in `mutate`,
  `room.set_public` refusal.
- `moderation.go`: `roomKick` calls `screenLeave` before `leaveRoom`.
- `cmd/server/main.go`: boot check, `ScreenOnDisconnect` first in
  `OnDisconnect`, client map registration.
- `cmd/server/report.go`, `internal/report/report.go`: `broadcast` kind.
- Migration (next free number after whatever PR #323 adds):

```sql
ALTER TABLE reports DROP CONSTRAINT reports_kind_check;
ALTER TABLE reports ADD CONSTRAINT reports_kind_check
    CHECK (kind IN ('message', 'member', 'room', 'broadcast'));

ALTER TABLE moderation_actions DROP CONSTRAINT moderation_actions_action_check;
ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
    CHECK (action IN ('chat.delete', 'room.kick',
                      'screen.start', 'screen.stop', 'screen.host_stop', 'screen.refuse'));
ALTER TABLE moderation_actions ADD COLUMN IF NOT EXISTS detail jsonb NOT NULL DEFAULT '{}';
```

  The constraint names are the Postgres defaults for the inline CHECKs in
  `0004_reports.sql` and `0005_moderation_actions.sql`. Dropping them by name
  is deliberate: a bare `ADD CONSTRAINT` would leave the old CHECK in force
  and every `broadcast` insert would still fail. The migration test asserts
  both new values insert. If PR #323 has already touched either constraint,
  rebase onto its names.

### 4.3 Metrics (`internal/obs/obs.go`)

| Series | Type | Source |
|---|---|---|
| `music_jam_screen_sessions_started_total` | counter | `screen.start` accepted |
| `music_jam_screen_sessions_ended_total{reason}` | counter | fixed set: `stopped`, `host_stopped`, `disconnect`, `kicked`, `takeover`, `shutdown` |
| `music_jam_screen_viewers_per_session` | histogram, buckets 0..5 | session end, `peakViewers` |
| `music_jam_screen_watch_rejected_total{reason}` | counter | `full`, `no_share`, `self`, `locked`, `refused` |
| `music_jam_rate_limit_rejected_total{method="rtc.signal"}` | existing | `rtcLimiter` |
| `music_jam_client_errors_total{name="screen_ice_failed"}` | existing | telemetry |
| `music_jam_product_events_total{name="screen_ice_connected"}` | existing | telemetry, the denominator |
| `music_jam_product_events_total{name="screen_capture_denied"}` | existing | picker cancelled |

ICE failure rate = `screen_ice_failed / (screen_ice_failed + screen_ice_connected)`,
the number the TURN trigger (1.1) is written against. Add `screen_ice_failed`
to `telemetryErrors` and the two events to `telemetryEvents`; nothing from the
request becomes a label. The endpoint is unauthenticated, so the rate is
advisory: good enough for a trigger, not for billing.

### 4.4 Durable trail

Every `screen.start` and every end (`screen.stop`, `screen.host_stop`,
disconnect, kick, takeover, shutdown where the process gets the chance) writes
a `moderation_actions` row through the `ModerationAudit` hook, whose signature
(`action, roomID, actorUserID, subjectID`) gains a `detail` argument in PR 5:
`actor_user_id` = broadcaster `sub` (or the host for `host_stop` and
`refuse`), `subject_id` = broadcaster `sub`, `detail` =
`{name, startedAt, endedAt, peakViewers, ageAffirmed, reason}`. No content, no
IP addresses. This is the record that answers "who broadcast in room X at
time T" and the source for report subjects (7.3). Retention follows whatever
#253 sets for the trail; the report lookup needs at least 7 days.

## 5. Client design (`apps/web`)

### 5.1 Flag

`screenShare: 'COJAM_FEATURE_SCREENSHARE'` in `FEATURE_ENV_VARS`,
`NEXT_PUBLIC_FEATURE_SCREENSHARE` fallback, default false, read through
`useRuntimeFeatures()`. The share button renders only when the flag is on, the
caller is host (or holds a grant), the room is private, and
`navigator.mediaDevices?.getDisplayMedia` exists. The server is still the
authority on every one of those.

### 5.2 Broadcaster

1. Age gate: if `!hasAffirmedAge()` (`lib/ageGate.ts`, shared with the
   directory gate), show the affirmation worded for broadcasting, then
   `affirmAge()`.
2. **Rights notice** in the same dialog, every share: "Não transmita conteúdo
   que você não tem direito de compartilhar. Filmes, séries, jogos pagos e
   transmissões esportivas costumam ter direitos de terceiros, e serviços com
   DRM aparecem em preto." Links the terms clause (#253).
3. Capture:

   ```ts
   navigator.mediaDevices.getDisplayMedia({
     video: { frameRate: { ideal: 15, max: 30 }, height: { max: 720 } },
     audio: true,                     // tab audio in Chromium; ignored where unsupported
     selfBrowserSurface: 'exclude',   // do not offer the CoJam tab itself
     surfaceSwitching: 'include',
     systemAudio: 'include',
   });
   ```

   Chromium shares tab audio everywhere and system audio on Windows and
   ChromeOS; Firefox and Safari return no audio track and the UI says so. A
   cancelled picker posts `screen_capture_denied` and returns to idle.
4. `track.contentHint = 'detail'`; a toggle sets `'motion'` for video content.
5. `screen.start { roomId, ageAffirmed: true }`. On refusal, stop the tracks.
6. On `screen.viewer join`: one `RTCPeerConnection` for that viewer (C1),
   `iceServers` from 5.4, `addTrack` each captured track, cap the encoder with
   `sender.setParameters({ encodings: [{ maxBitrate: 1_200_000 }] })` and
   `degradationPreference: 'maintain-resolution'`, offer, trickle candidates
   in 100ms batches.
7. On `screen.viewer leave` or `bye`: close that peer.
8. Broadcaster panel: viewer list (presence names), "Fechar entrada" (lock),
   "Remover desta transmissão" per viewer (refuse).
9. On the track's `ended` event: `screen.stop`, close everything.
10. On a publication without `screen`, or with another `broadcasterId`, or on
    **any** centrifuge disconnect: close every peer; offer "Resume sharing"
    if the track is still `live`.

### 5.3 Viewer

1. **No auto-watch.** A `RoomState` with `screen` shows a card in the stage:
   "<nome> está compartilhando a tela" with an **"Assistir"** button and one
   line under it: "Assistir conecta você diretamente a <nome>; vocês verão o
   endereço de rede um do outro." Clicking calls `screen.watch`. Full, locked
   and refused each have their own copy.
2. On the offer: `setRemoteDescription`, answer, trickle candidates.
3. `ontrack`: `<video autoplay playsInline muted>` inside `<Stage>`
   (`app/room/components/Stage.tsx`); "Tocar som" unmutes on gesture.
4. **Persistent notice** on the stage overlay for as long as the video shows,
   not dismissible: "Transmissão não moderada. O CoJam não vê nem grava o que
   é compartilhado." Next to it: "Denunciar" (5.6) and **"Parar de assistir"**
   (`screen.unwatch`, always available).
5. ICE: `failed`, or no `connected` within 15s, shows "Não foi possível
   conectar. Sua rede ou a de <nome> bloqueia conexões diretas, e o CoJam
   ainda não tem um servidor de retransmissão." One `restartIce()`, then
   telemetry `screen_ice_failed` and stop. First `connected` posts
   `screen_ice_connected`.
6. Leaving the room, the share ending, or any centrifuge disconnect: close the
   peer and drop the video immediately.

### 5.4 ICE servers

`[{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }]`,
overridable through a runtime `COJAM_STUN_URLS` in `/env.js`. No TURN (C5).
STUN requests disclose the client's address to Google and Cloudflare; the
privacy policy names both (PR 9 gate).

### 5.5 Renegotiation

- Surface switching keeps the same track: nothing to do.
- "Change source": new `getDisplayMedia`, then `sender.replaceTrack` on every
  peer. Renegotiate per peer only if audio appears or disappears; the
  broadcaster is the only offerer (enforced server-side, 2.4.7), so there is no
  glare in v1.

### 5.6 Reporting

"Denunciar transmissão" is on the overlay while live and for 10 minutes after.
It posts `kind: 'broadcast'` to `/api/report` with the room id and the
reporter's reason only; the server resolves the subject (7.3).

## 6. Failure modes

| Failure | Detection | User sees | Server effect |
|---|---|---|---|
| Symmetric NAT / CGNAT | ICE `failed` or 15s | 5.3.5 message | none; `screen_ice_failed` |
| IPv4-only mobile APN behind CGNAT | same | same | same; the prototype measures this per carrier |
| Uplink saturated | `qualityLimitationReason: 'bandwidth'` | broadcaster: "Sua conexão está no limite; menos espectadores ajudam" | none |
| CPU saturated | `qualityLimitationReason: 'cpu'` | same, CPU wording | none |
| Picker cancelled | `NotAllowedError` | back to idle | `screen_capture_denied` |
| No `getDisplayMedia` (most mobile) | feature detect | no share button; watching works | none |
| Signaling rate limited | UserError | broadcaster retries with backoff | `rate_limit_rejected{method="rtc.signal"}` |
| Target vanished mid-handshake | send miss | viewer path ends | viewer-leave path |
| Broadcaster drop not yet detected | old session still LIVE | "Resume" triggers takeover | session ended `reason="takeover"` |
| Kick of a viewer or broadcaster | `screenLeave` before `leaveRoom` | kicked client tears down on disconnect | slot freed or session ended |
| Server restart / deploy | reconnect | "A transmissão terminou (servidor reiniciou). Retomar?" | `reason="shutdown"` |
| DRM content | black frames | black video | none |
| Room audio duplicated | broadcaster shares an audible tab | warning when the shared surface has audio | none |
| Autoplay blocked | `play()` rejects | muted video, "Tocar som" | none |

## 7. Safety (ECA Digital, Lei 15.211), mapped to duties

### 7.1 Reduce exposure of minors to strangers' live transmissions

- **Private rooms only, unguessable ids only (C6).** Never in the directory,
  never listed while sharing, never on a guessable legacy id.
- **Explicit opt-in to watch (C3).** Nobody receives a stream without clicking
  "Assistir" after reading that it connects them directly to the sharer.
- **Host and broadcaster controls (C12).** Lock admission, refuse a person
  for the session, stop any share, kick.
- **Residual risk, stated:** a private room link can be posted publicly; kick
  and refuse do not stop a person returning under a fresh identity; only
  `screen.lock` holds. Q2 is an owner decision before rollout.

### 7.2 Age signal before the riskier action

- **Age affirmation before broadcasting (C8)**, `lib/ageGate.ts`,
  provisional `MINIMUM_AGE` 16 pending #253. Self-declared, no date of birth.
  `ageAffirmed` is recorded in the trail per session. Not verification.
- **Viewing is not gated** in v1. Q1 is an owner decision before rollout.

### 7.3 A reporting route that works for guests

- **`kind: 'broadcast'`** on `/api/report` (guest-accessible, rate-limited,
  body-capped, rune-safe, #286), migration in 4.2.
- **Subject from the trail.** The handler ignores client `subjectId` and
  `content` for `broadcast`, and looks up `moderation_actions` for that room:
  the session live at report time, else the most recent one in the previous
  **7 days**. `subject_id` gets the broadcaster `sub`; `content` gets the
  session `detail`.
- **Never rejected.** With no matching session, the report is stored with an
  empty subject and the reason as typed. A report the system cannot attribute
  is still a report someone has to read.
- **Delivery is the #323 webhook** (`REPORT_WEBHOOK_URL`), verified end to end
  before rollout (PR 9).
- **Nothing of what was on screen is retained.** Q3.

### 7.4 Act fast

- Host stop without kick, audited. Lock and refuse.
- Any viewer can stop watching at any moment (C13 overlay).
- Operator: web flag off hides it in about a minute; server flag off plus a
  restart ends every share; `SCREENSHARE_ROOM_ALLOWLIST` narrows it to named
  rooms on restart.
- **Gap:** no operator stop for one share without a restart. Q5 is an owner
  decision before rollout; ADR-0008 makes it a precondition for public rooms.
- Escalation runbook for a report indicating a minor at risk (#259 3.4) is a
  rollout gate.

### 7.5 Data minimization (LGPD, same authority)

- SDP and candidates carry public IPs: never logged, never persisted.
- Peers learn each other's public IP: disclosed at the point of choice (the
  "Assistir" line) and in the privacy policy, with the STUN providers.
- The trail carries `sub`, display name, times, peak viewers, age flag. No
  content, no IPs.

## 8. Prototype (the no-big-bang gate, about 2 hours)

Throwaway, not merged. The repo rule asks for a one-hour prototype; carrier
coverage below takes it to about two, and that is the right trade because the
result decides whether v1 is shippable without TURN at all.

**Shape.** Scratch directory outside the repo
(`/Volumes/External HD/Desenvolvimento/.worktrees/cojam-screen-proto/`): a Go
WebSocket relay of about 60 lines that forwards JSON between named peers, and
one static page with "share" and "watch" modes, using the same capture
options, ICE servers, bitrate cap and candidate batching as section 5.
Exposed through a temporary `cloudflared` quick tunnel. Torn down after.

**Matrix.**

- Broadcasters: two home connections on **two different ISPs**, one of them
  known to put customers behind CGNAT.
- Viewers: a phone on **Vivo, Claro and TIM**, each tested on its **default
  APN** and on an **IPv4-only APN** (6 viewer configurations), Wi-Fi off.
- Each viewer configuration is run against both broadcasters.

**Record per run:** time to first decoded frame; selected candidate pair type
(`host`, `srflx`, `prflx`, `relay` must never appear); IP family of the
selected pair (v4 or v6); **NAT mapping class** for the viewer, by gathering
srflx candidates from both STUN servers in one `RTCPeerConnection` and
comparing mapped ports (same port from both servers = endpoint-independent
mapping; different ports = address or port dependent, that is symmetric).
Also on one LAN run: broadcaster `bytesSent` per sender over 60s,
`qualityLimitationReason`, signaling message count per viewer join by kind,
largest message size, tab audio, late join, `replaceTrack`.

**NO-GO (stop, take it to the owner before PR 3) if any of:**

- any carrier shows symmetric mapping on either APN
- any carrier fails to connect on its IPv4-only APN
- 2 or more of the 6 carrier/APN configurations fail against either broadcaster

**Also fail (fix and re-run):** per-viewer send rate above the 1.2 Mbps cap or
not linear in viewers; more than 40 signaling messages per join or a message
above 12 KiB; late join or `replaceTrack` disturbing an existing viewer.

**Output.** A comment on #310 with the full matrix, and the constants in 2.4
and 5.2 updated in a follow-up commit to this spec.

## 9. Test plan

### 9.1 Server unit (`hub_screen_test.go`, `hub_signal_test.go`)

- flag off: every new RPC is `ErrorMethodNotFound`
- boot: screen share on with room auth off exits, **with `APP_ENV` unset**
- host check: room not loaded, `HostUserID == ""`, non-host, host; empty host
  is a refusal
- room id format: 6-char legacy id refused, 12-char ok; allowlist on and off
- `ageAffirmed` missing refused; public room refused; second start by another
  user refused; **same-`userId` takeover** ends the old session and notifies
- `room.set_public {public:true}` refused while live; `{public:false}` allowed;
  concurrent start and set_public under `-race`, 100 iterations, never both
- `screen.watch`: cap 5, sixth refused, one slot per `userId` (second tab moves
  the slot), self refused, locked refused, refused `userId` refused
- `screen.unwatch` always succeeds for an admitted viewer
- `rtc.signal`: non-member caller and target, viewer to viewer, non-admitted,
  no share, 16 KiB + 1, bad `kind`, extra fields, non-SDP, **offer from a
  viewer refused, answer from the broadcaster refused**, rate limit at the
  five-join burst, forged `from` ignored
- **kick regression:** call `roomKick` for the broadcaster, then replay the
  `OnDisconnect` sequence; the share is IDLE and published exactly once. Same
  for a kicked viewer (slot freed, broadcaster notified). Same through the
  `room.rebind` zombie-disconnect path
- `ScreenOnDisconnect` uses `screenByClient`: membership already cleared still
  ends the share
- persistence: `store.Save` never sees a non-nil `Screen`; reload has none
- trail: start and each end reason write one row with the `detail` fields
- reports: `broadcast` resolves from a live session, from a session 6 days
  old, stores an empty subject for none (never 400s), ignores client subject
- migration: inserts with `broadcast` and `screen.start` succeed after it
- metrics: started, ended by reason, viewers histogram, rejections by reason

### 9.2 Web unit (Vitest)

- peer manager (`lib/screenShare.ts`) with a fake `RTCPeerConnection`: one PC
  per viewer, close on leave, candidate batching, `replaceTrack` on all
  senders, **close all on centrifuge disconnect**
- age gate and rights notice before `getDisplayMedia`
- no `screen.watch` without a click; the disclosure line renders with the name
- persistent notice not dismissible; "Parar de assistir" calls unwatch
- button hidden: flag off, non-host, public room, no `getDisplayMedia`
- viewer states: connecting, full, locked, refused, ICE failed, tap for sound

### 9.3 E2E (Playwright, `e2e/screen-share.spec.ts`)

Server env `FEATURE_SCREENSHARE: 'on'`; Chromium launch args:

```ts
launchOptions: { args: [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--auto-select-desktop-capture-source=Entire screen',
  '--disable-features=WebRtcHideLocalIpsWithMdns',
] }
```

The last flag keeps host candidates as plain loopback addresses so CI does not
depend on mDNS. STUN is unreachable in CI; same-host peers connect over host
candidates. **Verify in the prototype that the fake-UI flag auto-accepts
`getDisplayMedia` in Playwright's headless Chromium**; if not, an
`addInitScript` replaces it with a `canvas.captureStream(15)` source.

1. **Acceptance:** host shares in a private room; two viewers click
   "Assistir" and each receives a track (`videoWidth > 0`, `framesDecoded`
   increasing over 2s).
2. **Acceptance:** public room refuses `screen.start`; button absent.
3. `room.set_public` while live is refused.
4. Host kicks a viewer: the viewer's video is gone and the broadcaster's
   viewer count drops within 5s.
5. Broadcaster closes the tab: viewers return to the normal stage within 5s.
6. Lock: a third viewer is refused after lock.
7. Selected candidate pair is never `relay` (C4 guard).

The sixth-viewer cap stays in 9.1: the server is the enforcement point.

## 10. Task breakdown (small PRs)

Each PR leaves `main` shippable with the flag off. Strictly sequential from
PR 2 to PR 4.

| PR | Scope | Size |
|---|---|---|
| 1 | Prototype (8), throwaway. Matrix on #310, constants updated here. NO-GO goes to the owner | ~2h |
| 2 | Contracts and plumbing, no behaviour: `protocol.md`, `protocol.ts` (types, `ServerMessage`, `SignalPayload`), flags, always-on boot check, `SCREENSHARE_ROOM_ALLOWLIST`, hub client map and `sendToClient` seam, `realtime.ts` `message` handler wired to a no-op | S |
| 3 | Server session: start, stop, watch, unwatch, lock, refuse, takeover, `RoomState.screen`, persistence strip, `set_public` refusal, `screenByClient`, `screenLeave` in `roomKick`, `ScreenOnDisconnect`, system lines, metrics. Tests 9.1 except signal and reports | M |
| 4 | Server signaling: `rtc.signal`, validation, direction, `rtcLimiter`. Tests 9.1 signal | M |
| 5 | Trail and reports: migration (both constraints, `detail`), trail writes, `broadcast` kind resolved from the trail, never rejected; telemetry allowlist | S |
| 6 | Web: peer manager, broadcaster flow (age, rights notice, panel), viewer flow ("Assistir", disclosure, persistent notice, stop watching), Stage integration, YouTube dock, report button. Tests 9.2. Split the peer manager from UI if it passes ~400 lines | M/L |
| 7 | Optional: `screen.allow` grant | S |
| 8 | E2E and Playwright config | S |
| 9 | Rollout, gated (below) | S |

**PR 9 does not flip any production flag until every gate is met:**

1. Monitored report destination verified end to end: a test `broadcast`
   report reaches `REPORT_WEBHOOK_URL` (#323) and someone confirms receipt.
2. Escalation runbook for a report indicating a minor at risk (#259 3.4),
   with a response commitment one person can meet.
3. Legal review (#259, #253) concluded, covering live transmission in private
   rooms, the age threshold, and trail retention.
4. Privacy policy entry for peer IP exposure and for the STUN providers
   (Google, Cloudflare).
5. Terms clause forbidding streaming content without rights, matching the
   notice in 5.2.
6. Owner decisions recorded on Q1, Q2 and Q5.
7. All series in 4.3 scraped, with a panel for the ICE failure rate.
8. Staging on; then production with `SCREENSHARE_ROOM_ALLOWLIST` set to named
   test rooms; then unset after a week with no unresolved report.

## 11. Acceptance criteria

- Two viewers who click "Assistir" receive the host's screen in a private room.
- Public room refuses `screen.start`; a live share refuses
  `room.set_public {public:true}`.
- A kick or rebind of the broadcaster ends the share; of a viewer frees the
  slot (unit replay of `roomKick` then `OnDisconnect`, and E2E 4).
- The sixth `screen.watch` is refused; one person never holds two slots.
- `rtc.signal` refuses every case in 2.4, including wrong direction.
- Host checks fail closed on an empty or unloaded host.
- No `screen` ever reaches the store; every session start and end is in the
  trail.
- Broadcast reports are never rejected and resolve their subject from the
  trail for 7 days.
- No TURN in the client ICE config; no relay pair in E2E.
- With both flags off, nothing changes for existing rooms.
- The server transmits no media bytes. Assert it explicitly in review.

## 12. Open questions

Q1, Q2 and Q5 are **owner decisions required before PR 9**.

- **Q1 (owner).** Should viewing also require the age affirmation?
- **Q2 (owner).** Is "private" enough when a link can be posted publicly? A
  cheap signal (distinct joiners per hour above a threshold) could disable
  `screen.start` for a room.
- **Q3.** Should a broadcast report capture one reporter-side frame? Better
  evidence, but retained image data, possibly of a minor.
- **Q4.** YouTube video playing when a share starts: dock it at 200x200 (this
  spec) or refuse `screen.start` until it is paused?
- **Q5 (owner).** Is a per-room operator stop without restart required before
  production, even for private rooms?
- **Q6.** `screen.allow`: ship in v1 (PR 7) or drop until asked for?
