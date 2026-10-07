import { test, expect, type Page } from '@playwright/test';
import { proxyConnectionToken } from './connectionTokenProxy';

// #306 /rooms directory: two public rooms are listed, a private room is not,
// search filters by name, and the sort switch reorders. Requires
// FEATURE_PUBLIC_ROOMS on the Go server and NEXT_PUBLIC_FEATURE_PUBLIC_ROOMS
// on the web dev server (both set in playwright.config.ts).

async function join(page: Page, roomId: string, name: string) {
  await proxyConnectionToken(page);
  await page.goto(`/room/${roomId}`);
  await expect(page.getByText(roomId, { exact: true })).toBeVisible();
  await page.getByPlaceholder('Your name').fill(name);
  await page.getByRole('button', { name: 'Join & Play' }).click();
  await expect(page.getByText(`you’re ${name}`)).toBeVisible();
}

async function makePublic(page: Page, label: string) {
  await page.getByRole('checkbox', { name: 'Public' }).click();
  await expect(page.getByRole('checkbox', { name: 'Public' })).toBeChecked();
  await page.getByLabel('Public room label').fill(label);
  await page.getByLabel('Public room label').press('Enter');
}

test('/rooms lists public rooms only, filters by search and reorders by sort', async ({ browser }) => {
  const suffix = Date.now().toString(36);
  const alpha = `e2eal${suffix}`;
  const beta = `e2ebe${suffix}`;
  const secret = `e2esx${suffix}`;
  const alphaLabel = `Alpha ${suffix}`;
  const betaLabel = `Beta ${suffix}`;

  // Alpha gets two connections so "most people" ranks it above Beta.
  const alphaHost = await (await browser.newContext()).newPage();
  await join(alphaHost, alpha, 'AlphaHost');
  await makePublic(alphaHost, alphaLabel);
  const alphaGuest = await (await browser.newContext()).newPage();
  await join(alphaGuest, alpha, 'AlphaGuest');

  const betaHost = await (await browser.newContext()).newPage();
  await join(betaHost, beta, 'BetaHost');
  await makePublic(betaHost, betaLabel);

  // Private by default: joined but never opted in.
  const secretHost = await (await browser.newContext()).newPage();
  await join(secretHost, secret, 'SecretHost');

  const visitor = await (await browser.newContext()).newPage();
  await proxyConnectionToken(visitor);
  await visitor.goto('/rooms');
  await expect(visitor.getByRole('heading', { name: 'Salas públicas' })).toBeVisible();

  // The directory polls every 15s; both public rooms must appear within one.
  const alphaCard = visitor.locator('.live-room-card').filter({ hasText: alphaLabel });
  const betaCard = visitor.locator('.live-room-card').filter({ hasText: betaLabel });
  await expect(alphaCard).toBeVisible({ timeout: 20_000 });
  await expect(betaCard).toBeVisible();
  await expect(visitor.getByText(secret, { exact: false })).toHaveCount(0);

  // Default sort is most people: Alpha (2) before Beta (1).
  const order = async () =>
    (await visitor.locator('.live-room-card__name').allTextContents()).filter(
      (n) => n === alphaLabel || n === betaLabel,
    );
  expect(await order()).toEqual([alphaLabel, betaLabel]);

  // Search narrows to one room.
  await visitor.getByRole('searchbox', { name: 'Buscar salas' }).fill('beta');
  await expect(betaCard).toBeVisible();
  await expect(alphaCard).toHaveCount(0);
  await visitor.getByRole('searchbox', { name: 'Buscar salas' }).fill('');
  await expect(alphaCard).toBeVisible();

  // Most recent: Beta was created and made public after Alpha's last
  // activity, so the order flips while the people ranking stays Alpha first.
  await visitor.getByRole('combobox').selectOption('recent');
  expect(await order()).toEqual([betaLabel, alphaLabel]);
});
