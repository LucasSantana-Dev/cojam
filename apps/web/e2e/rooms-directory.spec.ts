import { test, expect, type Page } from '@playwright/test';
import { proxyConnectionToken } from './connectionTokenProxy';
import { openAvatarMenu } from './helpers';

// #306 /rooms directory: two public rooms are listed, a private room is not,
// search filters by name, and the sort switch reorders. Requires
// FEATURE_PUBLIC_ROOMS on the Go server and NEXT_PUBLIC_FEATURE_PUBLIC_ROOMS
// on the web dev server (both set in playwright.config.ts).

async function join(page: Page, roomId: string, name: string) {
  await proxyConnectionToken(page);
  await page.goto(`/room/${roomId}`);
  await expect(page.getByText(roomId, { exact: true })).toBeVisible();
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Entrar na sala' }).click();
  await expect(page.getByTestId('room-me')).toContainText(name);
}

async function makePublic(page: Page, label: string) {
  await openAvatarMenu(page);
  await page.getByRole('checkbox', { name: 'Pública' }).click();
  await expect(page.getByRole('checkbox', { name: 'Pública' })).toBeChecked();
  await page.getByLabel('Nome da sala pública').fill(label);
  await page.getByLabel('Nome da sala pública').press('Enter');
}

test('/rooms lists public rooms only, filters by search and reorders by sort', async ({ browser }) => {
  const suffix = Date.now().toString(36);
  // Room ids follow the server format: uppercase base36, at most 12 chars.
  const idSuffix = suffix.toUpperCase();
  const alpha = `AL${idSuffix}`;
  const beta = `BE${idSuffix}`;
  const secret = `SX${idSuffix}`;
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
  await expect(visitor.getByRole('heading', { name: 'Salas ao vivo' })).toBeVisible();

  // The directory polls every 15s; both public rooms must appear within one.
  const alphaCard = visitor.locator('.pwr-room').filter({ hasText: alphaLabel });
  const betaCard = visitor.locator('.pwr-room').filter({ hasText: betaLabel });
  await expect(alphaCard).toBeVisible({ timeout: 20_000 });
  await expect(betaCard).toBeVisible();
  await expect(visitor.getByText(secret, { exact: false })).toHaveCount(0);

  // Default sort is most people: Alpha (2) before Beta (1).
  const order = async () =>
    (await visitor.locator('.pwr-room__name').allTextContents()).filter(
      (n) => n === alphaLabel || n === betaLabel,
    );
  expect(await order()).toEqual([alphaLabel, betaLabel]);

  // Search narrows to one room.
  await visitor.getByRole('searchbox', { name: 'Buscar por nome' }).fill('beta');
  await expect(betaCard).toBeVisible();
  await expect(alphaCard).toHaveCount(0);
  await visitor.getByRole('searchbox', { name: 'Buscar por nome' }).fill('');
  await expect(alphaCard).toBeVisible();

  // Most recent: Beta was created and made public after Alpha's last
  // activity, so the order flips while the people ranking stays Alpha first.
  await visitor.getByRole('button', { name: 'Mais recentes' }).click();
  expect(await order()).toEqual([betaLabel, alphaLabel]);
});
