# ADR-0003: Hero restraint — no object decoration behind the landing headline

**Date:** 2026-07-17
**Status:** accepted
**Decided via:** 4-lens debate (brand-design, conversion, legal/brand-safety,
craft/feasibility; 2 rounds + synthesis) after two operator rejections.

## Context

The landing hero ships a signature: a masked kinetic 3-line headline ("Your
friends. / Your platforms. / One *room.*", payoff word in violet gradient + glow)
over a dark ground with breathing aurora, faint grid mask, and film grain. Two
successive attempts to add a visual object behind it were rejected by the
operator:

1. A pulsing 3D icosahedron orb (R3F + three.js, synthetic beat pulse):
   "don't quite like that big ball."
2. Four real album covers as CSS-3D tilted planes with drift + cursor parallax,
   well executed: "didn't quite fit that good."

Both are literal objects floating beside the type. The rejection pattern, plus
the one-signature-per-screen rule, framed the decision.

## Decision

**Restraint.** Nothing lives behind the hero beyond what is already there:
kinetic type + aurora + grid + grain. No orb, no covers, no particles, no
waveform, no rings. The headline is the signature; the atmosphere layers are the
accompaniment. (The three.js/R3F removal from the orb rejection stays: the
landing carries no WebGL.)

## Alternatives considered

- **Sync rings** (concentric violet pulses emanating from the payoff word;
  CSS-only) — RUNNER-UP. Strongest fallback: zero deps, ties to "One room.",
  ~30 min to build. Deferred, not rejected.
- **Ambient waveform field** (canvas 2D) — rejected for now: conflates a product
  UI element (the planned waveform scrubber) with brand-hero decoration; no
  evidence the operator wants audio-native branding; unvalidated mobile cost.
- **Constellation of listeners** (particles linking) — narratively the best fit
  ("friends syncing into rooms") but a canonical SaaS particle meme
  (Discord/Figma-era) with unvalidated mobile perf; prototype-only fallback.
- **Recomposed floating covers** — rejected outright: the operator's taste
  rejection stands regardless of composition, and promotional use of copyrighted
  artwork on a marketing page carries unresolved licensing risk (separate from
  the in-app functional display in RoomShowcase).

## Consequences

- Positive: fastest possible hero (no extra paint work), zero new deps, the
  signature owns the screen, decision is fully reversible (runner-up is CSS).
- Negative: if the bare hero reads as "incomplete" rather than "intentionally
  minimal" to real visitors, motion must be revisited (see below).
- The debate flagged that all judgments are pre-traffic: no LCP/CTA baselines
  exist yet. Restraint is also the correct measurement baseline.

## Revisit when

- Real traffic exists and the hero baseline measures weak (bounce >25% or
  operator/user feedback says "too bare") — build the **sync rings** runner-up
  (CSS keyframes, violet-only, subtle scale pulse from behind "room.",
  reduced-motion: none) and compare.
- The waveform scrubber ships as a Day-1 in-product signature AND audio-native
  branding is explicitly wanted — re-evaluate the waveform field.
- Never revisit floating covers on the marketing hero without both a fresh
  operator ask and counsel sign-off on promotional artwork use.
