import { test, expect, type Page } from '@playwright/test';
import { proxyConnectionToken } from './connectionTokenProxy';

// Auth flows e2e (issue #123). Runs with FEATURE_ROOM_AUTH on for both the Go
// server and the web app (see playwright.config.ts).
//
// 1. Room-auth host/listener gating: the first joiner becomes host; host-only
//    queue controls render disabled for a listener. Server-side rejection of
//    listener RPCs is covered by Go unit tests (hub_authz_test.go).
// 2. /api/connection-token: request-level against the real Go server that
//    playwright.config.ts starts on :8080 (no mock, no skip).
// 3. Supabase sign-in entry points render only when the Supabase env is
//    present. The hosted project is never called: presence is simulated by
//    intercepting /env.js with dummy values and no OAuth flow is started.

async function join(page: Page, roomId: string, name: string) {
  await proxyConnectionToken(page);
  await page.goto(`/room/${roomId}`);
  // Waiting-room card shows the room code in a chip ("You're about to join <CODE>").
  await expect(page.getByText(roomId, { exact: true })).toBeVisible();
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Entrar na sala' }).click();
  // Joined header shows the room-code chip + "você é <name>" (see RoomClient header).
  await expect(page.getByTestId('room-me')).toContainText(name);
}

async function addTrack(page: Page, title: string, artist: string) {
  // Open the "Adicionar manualmente" details element using JavaScript to ensure it opens
  await page.evaluate(() => {
    const details = document.querySelector('details');
    if (details) details.open = true;
  });
  await page.getByPlaceholder('Título').fill(title);
  await page.getByPlaceholder('Artista').fill(artist);
  await page.getByRole('button', { name: 'Adicionar à fila' }).click();
  // Wait for the add to land (queue shows the title) before returning.
  await expect(page.getByTestId('queue-title').filter({ hasText: title })).toBeVisible();
}

test('room auth: listener sees host-only controls disabled, host sees them enabled', async ({ browser }) => {
  const roomId = `RA${Date.now().toString(36).toUpperCase()}`;

  // First joiner becomes the room host (server assigns hostUserId on room.join).
  const host = await (await browser.newContext()).newPage();
  const listener = await (await browser.newContext()).newPage();

  await join(host, roomId, 'Host');
  await join(listener, roomId, 'Listener');

  await addTrack(host, 'Alpha', 'A-One');
  await addTrack(host, 'Beta', 'B-Two');

  // Host: queue controls are enabled.
  await expect(host.getByRole('button', { name: 'Tocar' }).first()).toBeEnabled();
  await expect(host.getByRole('button', { name: 'Remover' }).first()).toBeEnabled();
  await expect(host.getByRole('button', { name: 'Mover para cima' }).nth(1)).toBeEnabled();
  await expect(host.getByRole('button', { name: 'Mover para baixo' }).first()).toBeEnabled();

  // Listener: the same controls render but stay disabled and say why (gating
  // is disabled={!canControl} in QueuePanel, driven by room/[id]/client.tsx).
  await expect(listener.getByRole('button', { name: 'Tocar' }).first()).toBeDisabled();
  await expect(listener.getByRole('button', { name: 'Remover' }).first()).toBeDisabled();
  await expect(listener.getByRole('button', { name: 'Mover para cima' }).nth(1)).toBeDisabled();
  await expect(listener.getByRole('button', { name: 'Mover para baixo' }).first()).toBeDisabled();
  await expect(listener.getByRole('button', { name: 'Remover' }).first())
    .toHaveAttribute('title', 'Só o anfitrião pode remover faixas');

  // Listeners can still add to the queue: membership-gated, not host-gated.
  await addTrack(listener, 'Listener Song', 'Someone');
  await expect(host.getByTestId('queue-title').filter({ hasText: 'Listener Song' })).toBeVisible();
});

// playwright.config.ts starts the Go server on :8080 for the whole e2e run,
// so these hit the real token endpoint (FEATURE_ROOM_AUTH on).
const TOKEN_ENDPOINT = 'http://localhost:8080/api/connection-token';

test('connection token: mint returns a JWT and userId', async ({ request }) => {
  const res = await request.get(TOKEN_ENDPOINT);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.userId).toBeTruthy();
  // JWT compact serialization: header.payload.signature
  expect(body.token.split('.')).toHaveLength(3);
});

test('connection token: ownership proof reissues identity, without proof a fresh one is minted', async ({ request }) => {
  const mint = await (await request.get(TOKEN_ENDPOINT)).json();

  const keptRes = await request.get(
    `${TOKEN_ENDPOINT}?userId=${encodeURIComponent(mint.userId)}&token=${encodeURIComponent(mint.token)}`,
  );
  expect(keptRes.ok()).toBeTruthy();
  const kept = await keptRes.json();
  expect(kept.userId).toBe(mint.userId);
  expect(kept.token).toBeTruthy();

  const freshRes = await request.get(`${TOKEN_ENDPOINT}?userId=${encodeURIComponent(mint.userId)}`);
  expect(freshRes.ok()).toBeTruthy();
  const fresh = await freshRes.json();
  expect(fresh.userId).toBeTruthy();
  expect(fresh.userId).not.toBe(mint.userId);
});

test('supabase: sign-in entry points render when the Supabase env is present', async ({ page }) => {
  // Simulate a Supabase-configured deployment by intercepting /env.js. The
  // values are dummies; the test never starts OAuth, so no real Supabase
  // project is ever contacted.
  await page.route('**/env.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript; charset=utf-8',
      body: 'window.__COJAM_ENV__ = { wsUrl: "", spotifyClientId: "", supabaseUrl: "https://e2e-dummy.supabase.co", supabaseAnonKey: "e2e-dummy-anon-key" };',
    }),
  );

  // Landing header entry point (app/page.tsx).
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();

  // Account page sign-in form (app/account/page.tsx).
  await page.goto('/account');
  await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
});

test('supabase: entry points stay hidden when the Supabase env is absent', async ({ page }) => {
  // The e2e web server has no Supabase env, so /env.js omits it and the
  // hydration-safe useSyncExternalStore gates keep the UI hidden.
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveCount(0);

  await page.goto('/account');
  await expect(page.getByText('Accounts are not configured on this deployment.')).toBeVisible();
});
