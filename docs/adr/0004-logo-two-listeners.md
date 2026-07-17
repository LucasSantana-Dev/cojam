# ADR-0004: Logo — "Two Listeners" (headphone of two presence dots)

**Date:** 2026-07-17
**Status:** accepted
**Decided via:** 2-researcher + 3-lens debate + synthesis, then operator
override on the first implementation; four crafted variants offered, operator
picked "Two Listeners". Amended same day.

## Context

CoJam needed a real mark. The de-facto identity was the wordmark beside a plain
glowing violet dot. Constraints: dark-first violet system, 16px favicon through
1024px app icon, monochrome-able, must not collide with music-app marks
(Spotify waves, Tidal diamond, Apple note, YouTube triangle, Last.fm 'as'), and
the operator's documented restraint taste (ADR-0003).

## Decision

**Two Listeners**: a headphone whose earcups are two violet presence dots
joined by the headband arc, with a pulse riding the band - the connection
metaphor built into the headphone anatomy, nothing glued on. Hand-authored
SVG (one arc + three circles), not AI-generated raster:

- `apps/web/app/components/Logo.tsx` - `LogoMark` (token-driven color, optional
  glow; glow OFF below ~24px where it muddies).
- `apps/web/app/icon.svg` - favicon (Next App Router convention): dark rounded
  tile + dot/ring, NO glow (16px legibility gate).
- `apps/web/app/apple-icon.png` - 180px tile with glow.
- Lockups: landing header, room join card (glow), room header. The old
  `.site-header .brand::before` dot pseudo-element is superseded and removed.

**16px gate: PASSED** - dot + ring render legibly at 16px on dark and light
(verified via rendered strip at 16/32/64px before wiring).

## Alternatives considered

- The dot, elevated (dot + concentric ring) - the debate winner, implemented
  first; REJECTED by the operator as "way too simple, just a circle". Third
  taste data point: distinctive figuration wanted, not bare geometry.
- Sync-wave and sync-ping headphone variants (waveform / facing arcs between
  cups) and orbit-room (headphone in a ring) - offered alongside the winner;
  denser at 16px, not picked.
- Room bracket (rounded square enclosing a dot) - earlier pre-staged fallback;
  superseded with the dot concept.
- Sync bars / equalizer abstraction - collides with the in-product equalizer's
  role; UI element, not identity.
- Venn overlap circles - generic SaaS collaboration territory.
- Monogram C/Cj - weakest differentiation, hardest at 16px.
- Wordmark-only - forfeits an ownable symbol; dot territory (Discord/Slack
  presence dots) is differentiated by the ring's room metaphor.
- AI-generated mark (Recraft/Ideogram) - unnecessary: the concept is two
  circles; hand-authored SVG is exact, tiny, and token-driven.

## Revisit when

- A light-theme brand context appears where the violet fails contrast.
- Marketing needs an animated mark (ring pulse = the sync-rings concept from
  ADR-0003 is the natural motion language).
- Trademark search (pre any paid launch) surfaces a collision.
