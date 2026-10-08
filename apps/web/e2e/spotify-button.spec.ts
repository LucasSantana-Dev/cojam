import { test, expect, type Page } from '@playwright/test';
import { proxyConnectionToken } from './connectionTokenProxy';

// With NEXT_PUBLIC_FEATURE_SPOTIFY on + a client id, a room shows the
// "Conectar Spotify" button. We never click it (that redirects to Spotify OAuth),
// so no Premium account or real SDK is needed — this asserts the gated UI renders.

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

test('Connect Spotify button renders when the feature flag is on', async ({ page }) => {
  await join(page, `SP${Date.now().toString(36).toUpperCase()}`, 'Lucas');
  await expect(page.getByRole('button', { name: 'Conectar Spotify' })).toBeVisible();
  // gated add-track field also appears (manual fields live behind the "Adicionar manualmente" toggle)
  await page.locator('details').first().evaluate((d) => ((d as HTMLDetailsElement).open = true));
  await expect(page.getByPlaceholder('Link do Spotify ou URI da faixa (opcional)')).toBeVisible();
});
