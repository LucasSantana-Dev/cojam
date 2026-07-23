import type { Page } from '@playwright/test';

// With FEATURE_ROOM_AUTH on, the browser fetches a connection token from the
// Go server before opening the websocket. That fetch is cross-origin
// (:3000 -> :8080) and the Go server sends no Access-Control-Allow-Origin
// header (deployments serve /api from the web origin, so it never needs one).
// Bridge the gap in the harness: perform the real request from Node (no CORS)
// and re-serve the response to the page with the header it requires. Token
// minting, identity continuity, and server-side validation all stay real.
export async function proxyConnectionToken(page: Page): Promise<void> {
  await page.context().route('http://localhost:8080/api/connection-token**', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'access-control-allow-origin': '*' },
    });
  });
}
