# 287 — Colour discipline: close the hex escapes in the OKLCH system

Status: proposed
Issue: [#287](https://github.com/LucasSantana-Dev/cojam/issues/287)
Related: #290 (accent balance), #291 (register lock and contrast evidence)

## Problem

`globals.css` declares an OKLCH design system, and several values bypass it.
The issue named 8 sites. A full sweep of `apps/web` found 35.

The cost is capability, not looks. In OKLCH a hover state is `calc(l + 0.06)`
and a disabled state is a chroma reduction, both on the same hue. A hex literal
cannot be adjusted that way without converting first, so every state gets
hand-tuned and the palette drifts.

## Measurements

All conversions round-trip to the identical hex, so representation changes
carry no visual change. Contrast is measured against `--color-surface-2`.

### Tokens that are hex in the token file

| Token | Hex | OKLCH |
|---|---|---|
| `--color-accent-2` | `#4ade80` | `oklch(0.800 0.182 151.7)` |
| `--logo-core-from` | `#a3e635` | `oklch(0.849 0.207 128.8)` |
| `--logo-core-to` | `#10b981` | `oklch(0.696 0.149 162.5)` |
| `--logo-frame-from` | `#6d5cff` | `oklch(0.587 0.232 281.2)` |
| `--logo-frame-to` | `#c661ff` | `oklch(0.681 0.233 311.2)` |

### The issue's midpoint instruction is rejected

The issue asks to set `--color-accent-2` to the midpoint of the logo core
endpoints. Measured, that is a different colour:

```
accent-2 today  oklch(0.800 0.182 151.7)  #4ade80
core midpoint   oklch(0.773 0.178 145.7)  #5dd26a
delta           L +0.028   C +0.004   H +6.0
```

A 6 degree hue rotation and a lightness step on the brand green is a design
decision, not a mechanical cleanup, and the issue itself frames the work as
"not aesthetics". This spec converts `--color-accent-2` exactly and records the
relationship in a comment. Whether the brand green should move to the true
midpoint is left to #290, which already owns accent balance.

### Status escapes

| Site | Hex | OKLCH | vs `--color-status-error` |
|---|---|---|---|
| player, callback | `#ef4444` | `oklch(0.637 0.208 25.3)` | same hue, L +0.037 |
| form error | `#f87171` | `oklch(0.711 0.166 22.2)` | same hue, L +0.111 |
| success toast | `#86efac` | `oklch(0.871 0.136 154.4)` | no success token exists |

`#ef4444` and the existing error token differ only in lightness on a matched
hue, so it folds into the token directly. `#f87171` is a deliberately softer
error used inline in a form; folding it into the same token would darken it and
drop contrast from 7.19:1 to 4.55:1. It becomes a lightness step on the same
hue instead, which is the capability the system is supposed to provide.

`#86efac` sits at hue 154.4, within 3 degrees of `--color-accent-2`. It becomes
a lightness step on the accent hue rather than a fourth green.

### Contrast, on `--color-surface-2`

| Colour | Ratio | WCAG AA (4.5:1) |
|---|---|---|
| `--color-status-error` | 4.55:1 | pass, thin margin |
| `#ef4444` (today) | 5.29:1 | pass |
| `#f87171` (today) | 7.19:1 | pass |
| `#86efac` (today) | 14.17:1 | pass |
| `--color-accent-2` | 9.79:1 | pass |

Folding `#ef4444` into the error token costs 5.29:1 to 4.55:1. Still AA, but
the margin is thin enough to record here rather than discover later. The new
soft-error step preserves the 7:1 that inline form errors have today.

## Sites that keep their hex, deliberately

Not every literal is an escape. These have no access to CSS custom properties
and changing them would break the surface they serve:

- `layout.tsx` `themeColor` — a browser metadata value, parsed outside CSS.
- `opengraph-image.tsx` — rendered by Satori at the edge, no cascade, no vars.
- `global-error.tsx` — renders when the app has crashed, possibly before the
  stylesheet loads. A literal is the point.
- `Logo.tsx` `var(--logo-x, #hex)` — these are fallbacks, not escapes. They are
  updated to match the converted tokens so the two forms cannot drift.

## Change

1. Convert the five hex tokens in `globals.css` to their exact OKLCH values.
2. Add `--color-status-ok` and `--color-status-error-soft`, each a lightness
   step on an existing hue, replacing the two greens and the soft red.
3. Give the three avatar and provider colours OKLCH token form. They appear in
   two files with the same values and no shared definition, so they become a
   documented three-step scale instead of six literals.
4. Point the status escapes at the tokens.
5. Update the `Logo.tsx` fallbacks to the converted values.
6. Add a vitest regression test that fails on a new hex literal in a colour
   position, with the deliberate exceptions listed above as an allowlist.

## Out of scope

- Moving the brand green to the core midpoint (#290).
- Whether violet or green should carry primary actions (#290).
- The register lock and full contrast matrix (#291). This spec produces the
  contrast evidence for the colours it touches, which #291 can absorb.

## Verification

- `pnpm --filter web test` — the new regression test passes, and fails when a
  hex is reintroduced.
- `pnpm --filter web build` — compiles.
- Every conversion round-trips to the original hex, so rendered output is
  unchanged except at the three status sites, whose before and after ratios are
  recorded above.
