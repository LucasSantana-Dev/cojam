import { test, expect, type Page } from '@playwright/test';
import { proxyConnectionToken } from './connectionTokenProxy';

// F8 room chat: live delivery over the room channel (server-first: the sender
// sees their own line via the chat.message publication) plus history seeding
// for late joiners/reloads from the server's last-50 in-memory ring.

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

async function sendChatMessage(page: Page, text: string) {
  await page.getByLabel('Message').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  // Wait for the publication round-trip so a subsequent send/assert cannot
  // race the field reset.
  await expect(page.getByTestId('chat-message').filter({ hasText: text })).toBeVisible();
}

test('two users see each other\'s chat messages live', async ({ browser }) => {
  const roomId = `e2ec${Date.now().toString(36)}`;

  const lucas = await (await browser.newContext()).newPage();
  const ana = await (await browser.newContext()).newPage();

  await join(lucas, roomId, 'Lucas');
  await join(ana, roomId, 'Ana');

  // Lucas sends; both render it (the sender via the publication round-trip).
  await sendChatMessage(lucas, 'hello from lucas');
  await expect(ana.getByTestId('chat-message').filter({ hasText: 'hello from lucas' })).toBeVisible();

  // Ana replies; Lucas receives (bidirectional).
  await sendChatMessage(ana, 'hi lucas');
  await expect(lucas.getByTestId('chat-message').filter({ hasText: 'hi lucas' })).toBeVisible();
});

test('chat history seeds from the server ring after a reload', async ({ page }) => {
  const roomId = `e2eh${Date.now().toString(36)}`;

  await join(page, roomId, 'Lucas');
  await sendChatMessage(page, 'before reload');

  // Reload auto-rejoins with the session-persisted name; chat.history must
  // reseed the panel even though this connection never saw the publication.
  await page.reload();
  await expect(page.getByText('you\u2019re Lucas')).toBeVisible();
  await expect(page.getByTestId('chat-message').filter({ hasText: 'before reload' })).toBeVisible();
});
