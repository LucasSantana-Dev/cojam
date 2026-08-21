# 261: Voice chat in room

Issue: [#261](https://github.com/LucasSantana-Dev/cojam/issues/261)
Status: spec, deferred — prerequisites not met
Date: 2026-08-20

## 1. The premise correction that reframes this

Voice chat was proposed on the reading that Discord's absence in Brazil created
an opening. That reading was wrong.

The August 2026 ANPD order suspended Discord's **livestream feature**. Discord
itself stays up, and **Discord voice works normally**. So voice chat does not
fill a gap Discord left. It is table stakes for competing with Discord as a
hangout venue at all, which is a far larger ask than the one this backlog was
sized for.

Video co-watching (#258) is the feature that maps to the actual gap. Voice does
not.

## 2. Why this is the most expensive item in the backlog

Every other feature here is metadata fan-out, which is close to free per user.
Voice is the first thing that makes users cost money, and it does so
continuously.

- **An SFU is required.** Mesh WebRTC degrades past roughly four participants,
  so LiveKit or mediasoup, self-hosted or paid. Either way it is a new
  always-on service, and self-hosting an SFU is materially harder to operate
  than anything currently running.
- **Bandwidth scales with concurrent talkers**, not with room count.
- **It breaks the moat.** The metadata-only architecture is what keeps CoJam off
  the path that killed Turntable.fm and plug.dj. Voice does not carry a music
  licence, so this is not the same risk, but it is the first media CoJam would
  relay, and the architectural discipline is worth naming before it erodes.
- **Moderation cost multiplies.** Voice abuse cannot be caught by the chat rate
  limiter, is not reviewable after the fact, and needs its own mute, kick and
  reporting paths. It compounds #259 rather than sitting beside it.
- **Mobile browser WebRTC in a backgrounded tab is unreliable**, which is a poor
  fit for a mobile-first audience.

## 3. Hard prerequisites

Not preferences. Each of these is a way this fails badly if skipped.

1. **A stable production deployment.** As of 2026-08-20 production had just come
   back from an 8-hour silent outage (#264) with no metrics configured (#199).
   Adding a real-time media service to an environment with no observability is
   not a serious plan.
2. **#244 resolved.** Voice will not survive a single instance that drops every
   room on deploy.
3. **#259 landed.** Voice without a reporting route is worse than chat without
   one, because there is no artifact to report.
4. **Retention data (#245/#251).** Voice is where the free tier stops being
   free. It should follow monetization (#262), not precede it.

## 4. Design sketch, deliberately thin

Do not expand this until section 3 is satisfied. When it comes up, the real
questions are:

- LiveKit Cloud versus self-hosted, priced against actual concurrent users
- push-to-talk versus open mic (push-to-talk is cheaper and calmer)
- per-room participant cap, which is also the natural paid tier boundary
- **music ducking**: everyone is listening to the same track, and duplicating
  the audio path into the voice mix is the genuinely hard UX problem here.
  Client-side ducking of the local player is the tractable version.

## 5. Recommendation

Do not build this next. If the goal is "a place for friends to hang out around
media", #258 delivers more against the actual Brazilian opening at a fraction of
the cost and with none of the ongoing spend.

Revisit when CoJam has retention worth defending and a revenue line to fund it.
