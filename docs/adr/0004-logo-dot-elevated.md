# ADR-0004: Logo — "the dot, elevated" (violet dot + concentric ring)

**Date:** 2026-07-17
**Status:** accepted
**Decided via:** 2-researcher + 3-lens debate (brand-identity, distinctiveness/
collision, scalability/craft) + synthesis; implemented same day.

## Context

Cojam needed a real mark. The de-facto identity was the wordmark beside a plain
glowing violet dot. Constraints: dark-first violet system, 16px favicon through
1024px app icon, monochrome-able, must not collide with music-app marks
(Spotify waves, Tidal diamond, Apple note, YouTube triangle, Last.fm 'as'), and
the operator's documented restraint taste (ADR-0003).

## Decision

**The dot, elevated**: the existing violet presence dot gains one soft
concentric ring - a room with someone inside. Pure geometry (two circles),
hand-authored SVG rather than AI-generated raster:

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

- Room bracket (rounded square enclosing a dot) - pre-staged fallback had the
  16px gate failed; not needed.
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
