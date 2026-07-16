import { test, expect, type Page } from '@playwright/test';

// Regression for the tracer-bullet demo: two users in one room, queue syncs
// live in both directions via centrifuge publications.

async function join(page: Page, roomId: string, name: string) {
  await page.goto(`/room/${roomId}`);
  await expect(page.getByText(`Room: ${roomId}`)).toBeVisible();
  await page.getByPlaceholder('Your name').fill(name);
  await page.getByRole('button', { name: 'Join & Play' }).click();
  await expect(page.getByText(`Room: ${roomId} as ${name}`)).toBeVisible();
}

async function addTrack(page: Page, title: string, artist: string, videoId?: string) {
  await page.getByPlaceholder('Title').fill(title);
  await page.getByPlaceholder('Artist').fill(artist);
  if (videoId) {
    await page.getByPlaceholder('YouTube Video ID (optional)').fill(videoId);
  }
  await page.getByRole('button', { name: 'Add to Queue' }).click();
}

test('two users see each other\'s queue additions live', async ({ browser }) => {
  const roomId = `e2e${Date.now().toString(36)}`;

  const lucas = await (await browser.newContext()).newPage();
  const ana = await (await browser.newContext()).newPage();

  await join(lucas, roomId, 'Lucas');
  await join(ana, roomId, 'Ana');

  // Lucas adds — Ana receives via publication (no reload)
  await addTrack(lucas, 'Me at the zoo', 'jawed', 'jNQXAC9IVRw');
  await expect(lucas.getByText('Me at the zoo').first()).toBeVisible();
  await expect(ana.getByText('Me at the zoo').first()).toBeVisible();
  await expect(ana.getByText('jawed by Lucas')).toBeVisible();

  // Ana adds — Lucas receives (bidirectional)
  await addTrack(ana, 'Second Song', 'Someone');
  await expect(lucas.getByText('Second Song')).toBeVisible();
  await expect(lucas.getByText('Someone by Ana')).toBeVisible();

  // First add auto-set now playing → YouTube iframe mounted on both
  // YT.Player replaces the target div with an iframe that inherits the id
  await expect(lucas.locator('iframe#youtube-player')).toBeVisible({ timeout: 15_000 });
  await expect(ana.locator('iframe#youtube-player')).toBeVisible({ timeout: 15_000 });

  // Remove propagates
  await ana.getByRole('button', { name: 'Remove' }).nth(1).click();
  await expect(lucas.getByText('Second Song')).not.toBeVisible();
});
