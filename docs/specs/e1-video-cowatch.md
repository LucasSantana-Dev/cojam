# E1: Video co-watching (YouTube synchronized playback)

Issue: [#258](https://github.com/LucasSantana-Dev/cojam/issues/258)
Status: spec, ready for review
Date: 2026-08-20

## 0. Why now, and the honest risk

Watch2Gether's core primitive is synchronized video with a shared queue and
chat. CoJam already has the shared queue, chat, voting, presence, host handoff
and moderation. It already plays YouTube through the IFrame API. The remaining
delta is genuinely small: keep video visible instead of audio-only, and add a
transport position sync that the audio path does not need because it advances
track-by-track rather than second-by-second.

Market context (verify before betting on it): in August 2026 the Brazilian AGU
ordered Discord to suspend its livestream feature under ECA Digital (Lei
15.211). Discord complied. The platform was **not** banned. So the opening is
narrower than "Discord is gone": it is that one specific way Brazilian groups
watched things together is currently unavailable inside Discord.

### The licensing question, stated plainly

Turntable.fm (2013) and plug.dj (2021) both died because music licensing cost
outran revenue. plug.dj had 60k daily users and 2,900 paying ones when it
folded. CoJam's metadata-only architecture is the specific thing that avoids
that fate: the server never touches audio or video bytes, so no synchronization
or public-performance license attaches to it. **Video co-watching must preserve
that property exactly.** Every client renders its own YouTube IFrame, which
serves YouTube's own ads and counts its own views. The server sends a video ID
and a timestamp, nothing else.

### YouTube ToS position

- YouTube's required-minimum-functionality policy allows one autoplaying player
  per page, which this design satisfies: one player, one page.
  <https://developers.google.com/youtube/terms/required-minimum-functionality>
- Background playback is prohibited; the player must be visible in the user's
  active tab. This design keeps it visible.
- **No explicit written permission for synchronized multi-viewer playback
  exists.** Watch2Gether has operated exactly this commercially for years with
  no public enforcement action, which is precedent, not permission.

Risk verdict: moderate. Acceptable, but the decision to accept it belongs to
the operator and should be recorded in an ADR before implementation starts, not
after.

## 0.5 Correction, 2026-08-21: most of this already exists

Verified against the code before implementing. The synchronized-playback
machinery this spec proposed was already built for audio, behind `FEATURE_SYNC`:

- `transport.play` / `transport.pause` / `transport.seek` exist, host-only,
  position clamped, `updatedAtServerMs` server-stamped
  (`docs/protocol.md:25-27,125-128,234`).
- `RoomState.transport` exists (`protocol.ts:33-37,46`).
- `useDriftCorrection` exists and is wired (`room/[id]/client.tsx:186`), with
  `computeExpectedPosition` / `shouldCorrect` / `DRIFT_THRESHOLD_MS` in
  `lib/playbackSync.ts`. The #177 re-fire guard is already in place.
- The YouTube player already renders visibly (`YouTubePlayer.tsx:197,258`).
- Non-embeddable videos are already handled: codes 100, 101 and 150
  (`YouTubePlayer.tsx:43-46`).

**What is actually missing** is far smaller than sections 2 to 4 below suggest:

1. `TrackRef.kind: 'audio' | 'video'`, which does not exist.
2. Video-appropriate layout: stage-with-panels, and a pinned player with tabbed
   panels on mobile. This is the real work, and it is UI rather than protocol.
3. A heartbeat republish for late-joiner convergence, if the existing
   publication cadence does not already cover it.

Sections 2 and 3 are kept below as the record of what was proposed, but should
be read as **already satisfied** rather than as work to do.

## 1. Goal and non-goals

**Goal.** A room can play a YouTube video that every member sees at the same
position, with the existing queue, chat and voting unchanged around it.

**Non-goals.**

- Netflix, Prime, Disney+ or any DRM platform. Watch2Gether needs a browser
  extension for those. Out of scope, and it is where the legal risk gets real.
- Server-side video relay or transcoding. This would destroy the metadata-only
  property that is the whole moat.
- Webcam or voice chat. Tracked separately.
- Frame-accurate sync. Sub-second drift is the target; broadcast accuracy is not
  needed and is not achievable over the IFrame API.

## 2. Protocol changes (`packages/shared/src/protocol.ts`)

### 2.1 Type changes

`TrackRef` gains a discriminator so the client knows whether to render audio-only
or video chrome:

```ts
kind: "audio" | "video"   // default "audio" when absent, so existing rooms are unaffected
```

`RoomState` gains a transport block for position sync:

```ts
transport: {
  positionMs: number        // authoritative position at serverTimeMs
  serverTimeMs: number      // server clock when positionMs was sampled
  paused: boolean
  rate: number              // reserved, always 1 in v1
}
```

Clients compute their own target as `positionMs + (now - serverTimeMs)` when not
paused. This is the same clock-skew handling the honest-data lock (#132) already
established for RoomState timestamps; reuse that machinery rather than inventing
a second one.

### 2.2 New RPC methods

- `transport.seek` — host only, sets `positionMs`.
- `transport.pause` / `transport.resume` — host only in v1. Whether members can
  pause is a product decision; Watch2Gether lets anyone, which is friendlier and
  more abusable. Start host-only, since host handoff (#166) already exists.

`transport.sync` is deliberately absent. Position rides on the existing
`room.state` publication rather than adding a second channel.

## 3. Server design (`apps/server`)

### 3.1 Transport state on Room

Transport lives on `Room` next to the queue. It persists through the existing
versioned store, so a server restart resumes a video near where it was rather
than at zero.

### 3.2 Hub changes (`internal/hub/hub.go`)

- Handle the three transport RPCs, host-gated through the same authorization
  path `queue.reorder` already uses.
- Emit a heartbeat `room.state` on a timer while a video plays, so late joiners
  and drifted clients re-converge without polling. Every 10s is enough for
  sub-second correction and is far below the fanout limiter budget.
- **Do not** put transport RPCs on `fanoutLimiter`. They touch no third-party
  API. Give them their own limiter sized for scrubbing, which is bursty by
  nature. Follow the pattern in `internal/hub/chat.go:29-38`.

### 3.3 Interaction with auto-advance

Auto-advance currently fires on track end. Video needs the same behaviour driven
by the IFrame `ENDED` state. Reuse the existing path rather than forking it, and
watch for the drained-queue regression that closed issue #175 fixed: a video
ending on an empty queue must not reset NowPlaying to the oldest played entry.

## 4. Web design (`apps/web`)

### 4.1 Feature flag

`NEXT_PUBLIC_FEATURE_VIDEO`, default false, following the runtime flag pattern
from RFC-0006 / #126. Ship dark, enable per room.

### 4.2 Player

The existing YouTube IFrame integration already handles playback. Changes:

- Render the player visibly rather than hidden, sized responsively. On mobile
  this must not require horizontal scroll (see the viewport issue).
- Drift correction: compare local `getCurrentTime()` against the computed target
  on each `room.state`. Correct only when drift exceeds a threshold, roughly 1s,
  because `seekTo` is visibly jarring. The re-fire bug closed in #177 is
  directly relevant here: do not run correction on every publication
  unconditionally.
- Buffering must not fight sync. A client that is buffering should let the
  target run ahead and catch up on resume rather than seeking repeatedly.

### 4.3 Layout

Video changes the room from a sidebar-with-list into a stage-with-panels. Chat
and queue move beside or below the player. On mobile the player pins to the top
and the panels tab underneath. This is the largest piece of work in the feature
and it is UI, not protocol.

## 5. Edge cases and failure modes

- **Embedding disabled.** Many videos block embedded playback. The IFrame API
  reports error codes 101 and 150. These must surface as a real message and skip
  the track, using the playback-failure surfacing added in #176. Silent stalls
  are the failure mode that killed the audio path before it was fixed.
- **Age-restricted content.** Cannot play embedded. Same handling as above, and
  it intersects with the minor-safety issue.
- **Regional blocking.** A video playable for the host may be blocked for a
  member. The room must not stall for everyone; the affected client shows the
  error and the room continues.
- **Tab backgrounded.** Browsers throttle timers in background tabs, so drift
  grows. On visibility change, resync immediately rather than incrementally.
- **Host disconnects mid-video.** Host handoff (#166) transfers transport
  control with the rest of host authority. Verify transport does not get stuck
  paused during the handoff window.
- **Mixed audio and video queue.** A queue can contain both. The client swaps
  chrome on `kind`. Do not assume a room is one or the other.

## 6. Acceptance criteria

- Two browsers in one room play the same video within 1s of each other.
- A late joiner converges within one heartbeat.
- Host seek and pause propagate to all members.
- A non-embeddable video surfaces an error and skips rather than stalling.
- A drained queue after a video ends does not reset NowPlaying (#175 regression
  guard).
- Drift correction does not re-fire on every state publication (#177 guard).
- Audio-only rooms behave exactly as before with the flag off.
- The server transmits no video bytes. Assert this explicitly in review.
- Mobile layout usable at 390x844 with no horizontal scroll.
- e2e covers two-browser video sync, matching the existing two-browser room sync
  test.
