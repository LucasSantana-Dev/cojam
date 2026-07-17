# Playwright e2e reports "0 tests" / times out — port 3000 not free

## Summary

Agents repeatedly ran `npx playwright test` while a `next dev` server was
already on port 3000 and read the result ("0 passed" or a 120s
`config.webServer` timeout) as "there are no tests" or a pass. There are real
tests (`e2e/room-sync.spec.ts`, `e2e/spotify-button.spec.ts`); the run never
started them.

## Root Cause

`apps/web/playwright.config.ts` starts its own web server with
`reuseExistingServer: false` on :3000 (intentional — it injects the feature-flag
env a stale flagless dev server would mask). If :3000 is occupied, Playwright
cannot bind it and the webServer step times out, producing zero test results.

## Prevention

- Run e2e via `pnpm --filter web e2e` — the `e2e` npm script now frees :3000
  (`lsof -ti:3000 | xargs kill -9`) before invoking Playwright.
- Never run raw `npx playwright test` with a dev server on :3000.
- **Detection:** a "0 passed / 0 failed" e2e result is a configuration failure,
  not a green run. Treat it as red and free the port.

## Evidence

Recurred across multiple subagents in the 2026-07-16/17 build session; each
"resolved" only after `pkill -f "next dev"; lsof -ti:3000 | xargs kill -9`, then
the suite reported "2 passed".
