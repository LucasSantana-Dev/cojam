import { test, expect, type Page } from '@playwright/test';
import { proxyConnectionToken } from './connectionTokenProxy';

// With NEXT_PUBLIC_FEATURE_SPOTIFY on + a client id, a room shows the
// "Connect Spotify" button. We never click it (that redirects to Spotify OAuth),
// so no Premium account or real SDK is needed — this asserts the gated UI renders.

async function join(page: Page, roomId: string, name: string) {
  await proxyConnectionToken(page);
  await page.goto(`/room/${roomId}`);
  // Waiting-room card shows the room code in a chip ("You're about to join <CODE>").
  await expect(page.getByText(roomId, { exact: true })).toBeVisible();
  await page.getByPlaceholder('Your name').fill(name);
  await page.getByRole('button', { name: 'Join & Play' }).click();
  // Joined header shows the room-code chip + "you're <name>" (see RoomClient header).
  await expect(page.getByText(`you\u2019re ${name}`)).toBeVisible();
}

test('Connect Spotify button renders when the feature flag is on', async ({ page }) => {
  await join(page, `sp${Date.now().toString(36)}`, 'Lucas');
  await expect(page.getByRole('button', { name: 'Connect Spotify' })).toBeVisible();
  // gated add-track field also appears (manual fields live behind the "Add manually" toggle)
  await page.locator('details').first().evaluate((d) => ((d as HTMLDetailsElement).open = true));
  await expect(page.getByPlaceholder('Spotify link or track URI (optional)')).toBeVisible();
});
