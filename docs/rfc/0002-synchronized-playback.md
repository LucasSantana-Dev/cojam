# RFC-0002: Synchronized Playback

Status: Proposed (decomposition only; execution gated on approval)
Pipeline: ralphinho-rfc-pipeline
Complements: ADR-0001 (MVP stack), RFC-0001 (persistence)

## 1. RFC intake

### Problem
Today CoJam syncs the queue and *which* track is now-playing, but each client
starts that track immediately on its own wall-clock and never re-syncs. So two
friends drift apart within seconds, and there is no shared play/pause/seek. The
core product promise, "listening together", is only half-built.

### Goals
- Start a track together: everyone hears roughly the same moment (within the
  cross-service physics floor, ~±500ms).
- Shared transport: play, pause, and seek propagate to every client.
- Stay together: correct drift over a session without audible thrashing.
- Ships dark behind a flag; when off, today's immediate-play behavior is unchanged.

### Non-goals
- Sub-100ms lip-sync. Cross-service masters differ; ~±500ms is physics (CLAUDE.md),
  not a bug. We target "clearly together", not sample-accurate.
- Forcing seek where a provider forbids it (see Spotify free tier below). Those
  clients degrade to best-effort, they do not block the room.
- A server-side audio clock. The server is authoritative for *intent* (position +
  timestamp), never an audio source.

### Decision: server-timestamp-anchored transport, client-side drift correction
Add an optional `transport { state, positionMs, updatedAtServerMs }` to RoomState.
When playing, a client's expected position is
`positionMs + (serverNow - updatedAtServerMs)`, where `serverNow` uses a
client-measured clock offset. A slow client seeks only when its measured drift
exceeds a threshold above the physics floor, so we never fight ±500ms.

Rationale: the server already broadcasts full RoomState on every mutation and is
the natural authority for *intent*. Anchoring to a server timestamp (not a raw
position) means a late-joining or reconnecting client computes the right position
from one snapshot, no chatty position streaming. The acting client reports its
own position on pause/seek (the only real source of truth for where playback
actually is), recorded last-writer-by-`version`.

### Revisit when
A provider ships a real "listen-together" primitive (server-driven sync), or we
add a service whose SDK exposes neither seek nor position (then that service is
start-together-only and this model degrades for it).

## 2. DAG decomposition

```
  U1 (server transport + RPCs)         U2 (IPlayer + 3 adapters)
        |            \                   /        |
        |             \                 /         |
        v              v               v          v
  U3 (clock offset)     `-----> U4 (drift loop) <-'      U5 (transport UI)
        |                          |
        `----------> U4 <----------'
                     |
                     v
             U6 (degradation + flag)
```

- **Wave 1 (parallel):** U1 (server) and U2 (web player abstraction) are independent.
- **Wave 2:** U3 (clock offset, needs U1's server-time ping) and U5 (transport UI,
  needs U1's RPCs + U2's players) run in parallel.
- **Wave 3:** U4 (drift-correction loop) needs U1 + U2 + U3.
- **Wave 4:** U6 (graceful degradation + feature flag) needs U4.

## 3. Unit specs

### U1 — Server transport state + RPCs
- id: `U1`
- depends_on: []
- scope: Add `Transport *TransportState` to `queue.RoomState` (`state`
  playing/paused/stopped, `positionMs int64`, `updatedAtServerMs int64`), JSON
  optional for back-compat. Add `transport.play` / `transport.pause` /
  `transport.seek` to `mutatingMethods` + `hub.dispatch` cases. The acting client
  sends its `positionMs`; the server stamps `updatedAtServerMs = time.Now().UnixMilli()`
  and bumps `Version`. Add a lightweight `sync.ping` read RPC returning
  `{serverNowMs}` (not mutating; U3 uses it). Mirror the type in
  `packages/shared/src/protocol.ts`.
- acceptance_tests: dispatch-level tests (per the dispatch-case-missing failure
  note) for each new method; `transport.pause` records the client-reported
  position; a stale (lower-version) transport mutation is rejected; `sync.ping`
  returns a monotonic server time; existing hub suite passes (transport is additive).
- risk_level: Tier 3 (protocol + state schema + new RPCs)
- rollback_plan: transport is optional and gated by the client flag; revert drops
  the fields with no consumer.

### U2 — IPlayer interface + adapters
- id: `U2`
- depends_on: []
- scope: Define `lib/playerInterface.ts` (`play`, `pause`, `seekToMs`,
  `getCurrentPositionMs`, `getDurationMs`, `onEnded`, `onPositionChanged`).
  Refactor SpotifyPlayer / YouTubePlayer / ApplePlayer to implement it, exposing
  the SDK calls that already exist but are unused: Spotify `player.seek` /
  `getCurrentState`, YouTube `seekTo` / `getCurrentTime`, Apple `seekToTime` /
  `currentPlaybackTime`. Behavior-preserving: today's auto-play-on-nowPlaying
  still works.
- acceptance_tests: each adapter reports a plausible position while playing and
  seeks to a target within tolerance; a capability probe reports whether seek is
  available (Spotify free tier / provider limits); existing room e2e still passes.
  **Validate live**: Apple `seekToTime` and YouTube sandboxed `seekTo` actually
  work (the mapping flagged both as unverified).
- risk_level: Tier 2 (multi-file refactor across three SDKs)
- rollback_plan: revert; components return to direct SDK calls.

### U3 — Clock offset estimation
- id: `U3`
- depends_on: [U1]
- scope: `lib/clockSync.ts`: call `sync.ping` a few times on join, estimate
  `offsetMs` (serverNow - clientNow) and RTT/2 (NTP-lite: take the sample with the
  smallest RTT). Re-estimate on reconnect. Expose `serverNow()`.
- acceptance_tests: pure estimator test (given samples, picks min-RTT offset);
  offset applied so `serverNow()` tracks a simulated server clock within RTT/2.
- risk_level: Tier 2 (isolated, testable pure core)
- rollback_plan: revert; drift loop falls back to `Date.now()` (works when
  client/server clocks are already close).

### U4 — Drift-correction loop
- id: `U4`
- depends_on: [U1, U2, U3]
- scope: `lib/playbackSync.ts` + wire into `client.tsx`. On transport changes,
  drive the active `IPlayer` (play/pause/seek to expected position). While
  playing, every ~1-2s compute `expected = positionMs + (serverNow() -
  updatedAtServerMs)`, compare to `getCurrentPositionMs()`, and seek only when
  `drift > threshold` (threshold set above the ~±500ms floor to avoid thrashing).
- acceptance_tests: pure function `computeExpectedPosition(transport, serverNow)`;
  `shouldCorrect(drift, threshold)` never corrects within the floor; a simulated
  drifting player converges after one correction; a paused transport holds position.
- risk_level: Tier 2 (integration; the audible behavior lives here)
- rollback_plan: flag-off disables the loop; players revert to immediate play.

### U5 — Transport UI
- id: `U5`
- depends_on: [U1, U2]
- scope: Play/pause control + a seek/scrubber in the now-playing panel, calling
  the transport RPCs optimistically (per the experience contract), reflecting
  `transport.state`. Keyboard-operable, reduced-motion safe.
- acceptance_tests: clicking play/pause issues the RPC and optimistically updates;
  the scrubber issues `transport.seek` on release (not per-tick); disabled with a
  reason when the active player lacks seek capability (from U2's probe).
- risk_level: Tier 2 (UI; follows the repaint/experience conventions)
- rollback_plan: revert the panel additions; nothing else depends on it.

### U6 — Graceful degradation + feature flag
- id: `U6`
- depends_on: [U4]
- scope: Gate the whole feature behind `FEATURE_SYNC` (server) /
  `NEXT_PUBLIC_FEATURE_SYNC` (web), like every other feature. When the active
  player can't seek (Spotify free tier, or a provider that rejects it), fall back
  to start-together-only: honor play/pause, skip drift seeks, and surface a quiet
  "best-effort sync" note. A non-seeking client never blocks the room.
- acceptance_tests: flag off → today's behavior exactly; a no-seek player honors
  play/pause but performs no seeks and does not throw; the capability note renders.
- risk_level: Tier 2 (gating + fallback)
- rollback_plan: flag stays off; feature is dark.

## 4. Unit scorecards

| Unit | Tier | Integration risk | Rough effort | Wave |
| --- | --- | --- | --- | --- |
| U1 server transport + RPCs | 3 | Medium (protocol/schema) | M | 1 |
| U2 IPlayer + adapters | 2 | Medium (3 SDKs, live-verify) | L | 1 |
| U3 clock offset | 2 | Low (pure core) | S | 2 |
| U5 transport UI | 2 | Low-Medium (UX) | M | 2 |
| U4 drift loop | 2 | High (the audible behavior) | M | 3 |
| U6 degradation + flag | 2 | Medium (fallback paths) | S | 4 |

## 5. Integration risk summary

- **Spotify free tier can't seek** (HIGH): `player.seek` needs Premium. U2 probes
  capability; U6 degrades those clients to start-together-only rather than erroring.
- **Apple `seekToTime` / YouTube sandboxed `seekTo` unverified** (MEDIUM): U2's
  acceptance tests must exercise them against the live SDKs before U4 relies on them.
- **Pause/seek source of truth is scattered** (HIGH): only the acting client knows
  the true position. The acting client reports it; server records last-writer-by-
  `version`. Accept that a pause snapshots one client's head, not a global truth.
- **Message ordering / simultaneous transport RPCs** (MEDIUM): version-guarded,
  last-writer-wins; clients converge to the highest `version`.
- **Thrash avoidance** (MEDIUM): the correction threshold must sit above the
  ~±500ms physics floor, or clients seek constantly and audibly. U4's
  `shouldCorrect` test encodes this.
- **Clock skew** (MEDIUM): if a client's clock is far off and `sync.ping` fails,
  U3 falls back to `Date.now()`; drift correction still works when clocks are close.

## 6. Merge queue order

`U1 ∥ U2` → `U3 ∥ U5` → `U4` → `U6`. Rebase each unit on the integration branch
before merge; re-run `go test -race ./...` + web vitest + the two-browser room
e2e after each queued merge. The two-browser e2e is the real acceptance surface
for U4 (does a second browser actually converge?).

## 7. Follow-up refinements (post-implementation)

Captured from review of the shipped units; the feature is flag-gated
(`FEATURE_SYNC` off by default), so these harden it before it is enabled widely:

- **Bound `positionMs` server-side.** U1 clamps negative positions to 0; it does
  not yet reject a position past the track's known duration. Not harmful (a seek
  past the end simply ends the track), but validating the upper bound against the
  now-playing track's `durationMs` would reject nonsense input.
- **Gate transport mutations on track identity + version.** Transport writes are
  currently last-writer-by-`Version` with no check that the caller's view is
  current. A `transport.seek` issued against a track the room has already moved
  past would still apply. Accepting an optional `trackId` / `expectedVersion` on
  the transport RPCs and rejecting a mismatch (as `now_playing.advance` already
  does idempotently) would prevent a stale seek from disrupting a room that just
  changed tracks.

Both are low-severity for the initial flag-gated rollout and are logged here so
they are not lost.
