import { test, expect, type Page } from '@playwright/test';
import { proxyConnectionToken } from './connectionTokenProxy';

// F4 queue voting: members upvote queued tracks, counts sync live, and the
// most-voted track gets a listeners-pick marker. Reorder stays host-driven;
// votes are only a suggestion. Requires FEATURE_QUEUE_VOTING on the Go server
// and NEXT_PUBLIC_FEATURE_QUEUE_VOTING on the web dev server (both set in
// playwright.config.ts).

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

test('voting a queued track increments the count, second click decrements', async ({ browser }) => {
  const roomId = `E2EV${Date.now().toString(36).toUpperCase()}`;

  const page = await (await browser.newContext()).newPage();
  await join(page, roomId, 'Voter');
  await addTrack(page, 'Vote Me', 'Artista');

  const row = page.getByTestId('queue-item').first();
  const voteButton = row.getByRole('button', { name: 'Votar' });
  await expect(row.getByTestId('vote-count')).toHaveText('0');

  await voteButton.click();
  await expect(row.getByTestId('vote-count')).toHaveText('1');
  await expect(voteButton).toHaveAttribute('aria-pressed', 'true');

  await voteButton.click();
  await expect(row.getByTestId('vote-count')).toHaveText('0');
  await expect(voteButton).toHaveAttribute('aria-pressed', 'false');
});

test('votes sync live to another member and the listeners pick is marked', async ({ browser }) => {
  const roomId = `E2EP${Date.now().toString(36).toUpperCase()}`;

  const host = await (await browser.newContext()).newPage();
  const listener = await (await browser.newContext()).newPage();

  await join(host, roomId, 'Host');
  await join(listener, roomId, 'Listener');

  await addTrack(host, 'Opening Song', 'A-One');
  await addTrack(host, 'Challenger', 'B-Two');

  const challenger = listener.getByTestId('queue-item').filter({ hasText: 'Challenger' });
  await challenger.getByRole('button', { name: 'Votar' }).click();

  // The count reaches the host via publication (no reload), and the marker
  // lands on the most-voted queued track (the now-playing song is excluded).
  const hostChallenger = host.getByTestId('queue-item').filter({ hasText: 'Challenger' });
  await expect(hostChallenger.getByTestId('vote-count')).toHaveText('1');
  await expect(hostChallenger.getByTestId('listeners-pick')).toBeVisible();
  await expect(host.getByTestId('queue-item').filter({ hasText: 'Opening Song' })
    .getByTestId('listeners-pick')).not.toBeVisible();
});
