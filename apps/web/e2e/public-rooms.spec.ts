import { test, expect, type Page } from '@playwright/test';
import { proxyConnectionToken } from './connectionTokenProxy';

// F1 public rooms: the host opts the room into the public directory
// (PublicRoomToggle), the landing page's LiveRoomsSlot swaps the static
// example-room mock for the live strip once the poll sees it (LiveRoomsStrip),
// and the card's join link lands the visitor in the room. Flag off or an empty
// directory keeps the mock. Requires FEATURE_PUBLIC_ROOMS on the Go server and
// NEXT_PUBLIC_FEATURE_PUBLIC_ROOMS on the web dev server (both set in
// playwright.config.ts).

async function join(page: Page, roomId: string, name: string) {
  await proxyConnectionToken(page);
  await page.goto(`/room/${roomId}`);
  // Waiting-room card shows the room code in a chip ("You're about to join <CODE>").
  await expect(page.getByText(roomId, { exact: true })).toBeVisible();
  await page.getByPlaceholder('Your name').fill(name);
  await page.getByRole('button', { name: 'Join & Play' }).click();
  // Joined header shows the room-code chip + "you're <name>" (see RoomClient header).
  await expect(page.getByText(`you’re ${name}`)).toBeVisible();
}

test('host enables public, the landing strip lists the room, and the join link lands in the room', async ({ browser }) => {
  const roomId = `e2epub${Date.now().toString(36)}`;

  const host = await (await browser.newContext()).newPage();
  await join(host, roomId, 'Host');

  // Visitor on the landing page: with an empty directory the slot renders the
  // static example-room mock (no live cards).
  const visitor = await (await browser.newContext()).newPage();
  await proxyConnectionToken(visitor);
  await visitor.goto('/');
  await expect(visitor.getByText('Example room · NEON-4821')).toBeVisible();
  await expect(visitor.locator('.live-room-card')).toHaveCount(0);

  // The host (first joiner) opts the room into the directory with a label.
  // The checkbox is controlled by the room-state publication, so click and
  // wait for the round-trip rather than check() (which verifies immediately).
  await host.getByRole('checkbox', { name: 'Public' }).click();
  await expect(host.getByRole('checkbox', { name: 'Public' })).toBeChecked();
  await host.getByLabel('Public room label').fill('E2E Lounge');
  await host.getByLabel('Public room label').press('Enter');

  // The strip polls every 15s; the card must appear within one poll interval,
  // replacing the mock.
  const card = visitor.locator('.live-room-card').filter({ hasText: 'E2E Lounge' });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(visitor.getByText('Example room · NEON-4821')).toHaveCount(0);

  // The card is the join link, but a directory join is age-gated (#259):
  // joining by invite link is untouched, joining a stranger room asks first.
  await card.click();
  await expect(visitor.getByRole('dialog')).toBeVisible();
  await visitor.getByRole('button', { name: /or over/i }).click();
  await expect(visitor).toHaveURL(new RegExp(`/room/${roomId}$`));
  await expect(visitor.getByText(roomId, { exact: true })).toBeVisible();
  await visitor.getByPlaceholder('Your name').fill('Visitor');
  await visitor.getByRole('button', { name: 'Join & Play' }).click();
  await expect(visitor.getByText('you’re Visitor')).toBeVisible();
});

test('flag off renders the static example-room fallback', async ({ page }) => {
  // Simulate a flag-off deployment by intercepting /env.js (the runtime flag
  // map overrides the build-time one post-mount, RFC-0006). Same pattern as
  // auth.spec.ts's Supabase env simulation.
  await page.route('**/env.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript; charset=utf-8',
      body: 'window.__COJAM_ENV__ = { wsUrl: "", spotifyClientId: "", features: { publicRooms: false } };',
    }),
  );

  await page.goto('/');
  // The directory never loads with the flag off: the mock stays and no live
  // card renders, even though the previous test left a public room behind.
  await expect(page.getByText('Example room · NEON-4821')).toBeVisible();
  await expect(page.locator('.live-room-card')).toHaveCount(0);
  await expect(page.locator('.live-rooms')).toHaveCount(0);
});
