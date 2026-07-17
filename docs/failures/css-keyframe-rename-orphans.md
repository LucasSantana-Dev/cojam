# Keyframe rename orphaned animation refs (invisible hero)

## Summary

A motion refactor renamed `@keyframes word-rise` to `word-rise-masked` and updated
the headline, but `.hero-sub` and `.hero-cta` still referenced `word-rise`. Both
start at `opacity: 0` and animate to visible, so with the keyframe gone the hero
subcopy and CTA were permanently invisible. Only reduced-motion users (whose
override forces `opacity: 1`) saw them. tsc, lint, build, and e2e all stayed green.

## Root Cause

CSS animations fail silently: referencing a nonexistent keyframe is not an error,
the animation just never runs. Any element whose base state is hidden then stays
hidden. The agent that made the rename verified the headline it changed, not the
other selectors sharing the old keyframe name.

## Prevention

`scripts/check_web_drift.sh` rule 1: every `animation: <name>` in `globals.css`
must have a matching `@keyframes <name>`. Runs in the CI web job. When renaming a
keyframe, grep for the old name first.

## Evidence

Caught by the 2026-07-17 audit-deep delta pass (code-reviewer agent), confirmed by
grep, fixed on `feat/signature-motion` by pointing both selectors at the existing
`fade-in-up` keyframe. Injection test: adding a bogus `animation:` ref makes the
check exit 1.
