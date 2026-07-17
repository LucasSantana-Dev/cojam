# Builder agent shipped off-palette accent colors

## Summary

A UI-builder agent implementing the landing RoomShowcase used `text-orange-300`
for eyebrows and hover tints on a strictly violet-branded surface. All automated
gates (tsc, lint, build, e2e) passed; only a manual re-review caught it. The same
component also duplicated design-token values as raw `oklch(...)` literals, which
would silently drift when tokens change.

## Root Cause

Nothing enforces the palette. Tailwind happily generates any color utility, and
agents reach for framework default colors when a prompt says "accent" without a
machine-checkable constraint. Token duplication happens because inline styles
cannot be linted against the token file by default.

## Prevention

`scripts/check_web_drift.sh` rule 2: off-palette Tailwind color utilities
(orange/amber/teal/pink/etc.) in `apps/web/app` fail the check; runs in the CI
web job. Convention: colors come from `var(--color-*)` tokens or `color-mix()`
over them; raw hex is allowed only in data (per-source badge colors, presence
avatar colors), not in styling.

## Evidence

2026-07-17 RoomShowcase build: 6 `orange-300` usages fixed to `var(--color-accent)`,
plus a token-literal sweep (`color-mix` for alpha variants). Injection test: a
`text-orange-300` in a scratch tsx makes the check exit 1.
