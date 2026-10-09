import { test, expect, type Page } from '@playwright/test';
import { proxyConnectionToken } from './connectionTokenProxy';
import { openAdd } from './helpers';

// Vote to skip: with two listeners in the room, one vote shows "Pular 1/2" to
// both and the track keeps playing; the second vote passes the track. Rides
// FEATURE_QUEUE_VOTING (set for the Go server and the web dev server in
// playwright.config.ts).

async function join(page: Page, roomId: string, name: string) {
  await proxyConnectionToken(page);
  await page.goto(`/room/${roomId}`);
  await expect(page.getByText(roomId, { exact: true })).toBeVisible();
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Entrar na sala' }).click();
  await expect(page.getByTestId('room-me')).toContainText(name);
}

const YT_ID = 'jNQXAC9IVRw';

async function addTrack(page: Page, title: string, artist: string) {
  await openAdd(page);
  await page.getByPlaceholder('Título').fill(title);
  await page.getByPlaceholder('Artista').fill(artist);
  await page.getByPlaceholder('Link do YouTube ou ID do vídeo (opcional)').fill(YT_ID);
  await page.getByRole('button', { name: 'Adicionar à fila' }).click();
  await expect(page.locator('[data-testid="queue-title"], .r4-now__title').filter({ hasText: title }).first()).toBeVisible();
}

test('two listeners vote to skip and the track advances', async ({ browser }) => {
  // <= 12 chars (ValidRoomID); the random tail keeps parallel workers apart.
  const roomId = `S${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  // The YouTube embed is held pending on purpose: where it cannot load (CI has
  // no route to youtube.com) the host's client reports the video unplayable and
  // skips the track about 2 s later (useSkipUnplayable), which would race the
  // votes. A request that never answers neither plays nor errors.
  const newPage = async () => {
    const ctx = await browser.newContext();
    await ctx.route(/youtube\.com|ytimg\.com|googlevideo\.com|youtube-nocookie\.com/, () => {});
    return ctx.newPage();
  };
  const a = await newPage();
  const b = await newPage();

  await join(a, roomId, 'Ana');
  await join(b, roomId, 'Beto');
  await addTrack(a, 'First Song', 'A-One');
  await addTrack(a, 'Second Song', 'B-Two');
  await expect(b.locator('.r4-now__title')).toHaveText('First Song');

  const skipA = a.getByRole('button', { name: /Pular/ });
  const skipB = b.getByRole('button', { name: /Pular/ });
  await expect(skipA).toHaveText('Pular 0/2');

  await skipA.click();
  await expect(skipA).toHaveAttribute('aria-pressed', 'true');
  await expect(skipA).toHaveText('Pular 1/2');
  // The other listener sees the count, unpressed, and the track keeps playing.
  await expect(skipB).toHaveText('Pular 1/2');
  await expect(skipB).toHaveAttribute('aria-pressed', 'false');
  await expect(b.locator('.r4-now__title')).toHaveText('First Song');

  await skipB.click();
  await expect(b.locator('.r4-now__title')).toHaveText('Second Song');
  await expect(a.locator('.r4-now__title')).toHaveText('Second Song');
  // The votes reset with the new track.
  await expect(a.getByRole('button', { name: /Pular/ })).toHaveText('Pular 0/2');
  await expect(a.getByRole('button', { name: /Pular/ })).toHaveAttribute('aria-pressed', 'false');
});
