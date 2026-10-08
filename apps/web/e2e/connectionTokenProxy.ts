import type { Page } from '@playwright/test';

// With FEATURE_ROOM_AUTH on, the browser fetches a connection token from the
// Go server before opening the websocket. That fetch is cross-origin
// (:3000 -> :8080) and the Go server sends no Access-Control-Allow-Origin
// header (deployments serve /api from the web origin, so it never needs one).
// Bridge the gap in the harness: perform the real request from Node (no CORS)
// and re-serve the response to the page with the header it requires. The
// request is a form-encoded POST (a CORS simple request, so no preflight) and
// route.fetch() replays it with its body. Token
// minting, identity continuity, and server-side validation all stay real.
// E2E_SERVER_ORIGIN is a local-only knob (playwright.config.ts and auth.spec.ts still use 8080).
const SERVER_ORIGIN = process.env.E2E_SERVER_ORIGIN ?? 'http://localhost:8080';

export async function proxyConnectionToken(page: Page): Promise<void> {
  await page.context().route(`${SERVER_ORIGIN}/api/connection-token**`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'access-control-allow-origin': '*' },
    });
  });
}
