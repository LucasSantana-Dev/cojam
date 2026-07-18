import { test, expect, type Page } from '@playwright/test';

// Regression for the tracer-bullet demo: two users in one room, queue syncs
// live in both directions via centrifuge publications.

async function join(page: Page, roomId: string, name: string) {
  await page.goto(`/room/${roomId}`);
  // Waiting-room card shows the room code in a chip ("You're about to join <CODE>").
  await expect(page.getByText(roomId, { exact: true })).toBeVisible();
  await page.getByPlaceholder('Your name').fill(name);
  await page.getByRole('button', { name: 'Join & Play' }).click();
  // Joined header shows the room-code chip + "you're <name>" (see RoomClient header).
  await expect(page.getByText(`you're ${name}`)).toBeVisible();
}

async function addTrack(page: Page, title: string, artist: string, videoId?: string) {
  // Open the "Add manually" details element using JavaScript to ensure it opens
  await page.evaluate(() => {
    const details = document.querySelector('details');
    if (details) details.open = true;
  });
  await page.getByPlaceholder('Title').fill(title);
  await page.getByPlaceholder('Artist').fill(artist);
  if (videoId) {
    await page.getByPlaceholder('YouTube link or video ID (optional)').fill(videoId);
  }
  await page.getByRole('button', { name: 'Add to Queue' }).click();
  // Wait for the add to land (queue shows the title) before returning, so a
  // subsequent add doesn't race this submit's field-reset and lose its input.
  await expect(page.getByTestId('queue-title').filter({ hasText: title })).toBeVisible();
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
  // Ana receives Lucas's add in her queue. Scope to queue rows: the now-playing
  // hero also shows the title/artist, so an unscoped text match is ambiguous.
  await expect(ana.getByTestId('queue-title').filter({ hasText: 'Me at the zoo' })).toBeVisible();

  // Ana adds, Lucas receives (bidirectional)
  await addTrack(ana, 'Second Song', 'Someone');
  await expect(lucas.getByTestId('queue-title').filter({ hasText: 'Second Song' })).toBeVisible();

  // First add auto-set now playing → YouTube iframe mounted on both
  // YT.Player replaces the target div with an iframe that inherits the id
  await expect(lucas.locator('iframe#youtube-player')).toBeVisible({ timeout: 15_000 });
  await expect(ana.locator('iframe#youtube-player')).toBeVisible({ timeout: 15_000 });

  // Remove propagates
  await ana.getByRole('button', { name: 'Remove' }).nth(1).click();
  await expect(lucas.getByText('Second Song')).not.toBeVisible();
});

test('queue reorder syncs to both clients', async ({ browser }) => {
  const roomId = `e2er${Date.now().toString(36)}`;

  const lucas = await (await browser.newContext()).newPage();
  const ana = await (await browser.newContext()).newPage();

  await join(lucas, roomId, 'Lucas');
  await join(ana, roomId, 'Ana');

  await addTrack(lucas, 'Alpha', 'A-One');
  await addTrack(lucas, 'Beta', 'B-Two');

  // Both clients see the queue in insertion order [Alpha, Beta].
  await expect(ana.getByTestId('queue-title').nth(1)).toHaveText('Beta');
  await expect(lucas.getByTestId('queue-title').first()).toHaveText('Alpha');

  // Lucas moves Beta (2nd item) up; order becomes [Beta, Alpha] on BOTH clients.
  await lucas.getByTestId('queue-item').nth(1).getByRole('button', { name: 'Move up' }).click();

  await expect(lucas.getByTestId('queue-title').first()).toHaveText('Beta');
  await expect(ana.getByTestId('queue-title').first()).toHaveText('Beta');
});
