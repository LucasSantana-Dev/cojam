# CI Web job failed: "No pnpm version is specified"

## Summary

The `Web` CI job failed at setup (4s) with `Error: No pnpm version is specified`,
blocking the PR before any test ran.

## Root Cause

`.github/workflows/ci.yml` uses `pnpm/action-setup@v4` with no `version:` input,
and the root `package.json` had no `packageManager` field. pnpm/action-setup v4
requires one or the other to resolve a version.

## Prevention

- **Rule:** keep the `packageManager` field in the root `package.json` (e.g.
  `"packageManager": "pnpm@11.11.0"`). pnpm/action-setup and Corepack read it.
- **Detection:** removing it re-breaks the `Web` CI job immediately (fast fail),
  which is the regression signal. Keep the Docker `RUN npm install -g pnpm@<v>`
  pin aligned with it.

## Evidence

Fixed 2026-07-17 by adding `"packageManager": "pnpm@11.11.0"`; the Web job then
passed.
