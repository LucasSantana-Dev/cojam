import { test, expect, type Page } from '@playwright/test';
import { proxyConnectionToken } from './connectionTokenProxy';
import { openAdd, openAvatarMenu } from './helpers';

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
  // The avatar menu holds the name (room-me).
  await expect(page.getByTestId('room-me')).toContainText(name);
}

test('Connect Spotify button renders when the feature flag is on', async ({ page }) => {
  await join(page, `SP${Date.now().toString(36).toUpperCase()}`, 'Lucas');
  // The connect button lives in the avatar menu, under "Trocar serviço".
  await openAvatarMenu(page);
  await page.getByRole('button', { name: 'Trocar serviço' }).click();
  await expect(page.getByRole('button', { name: 'Conectar Spotify' }).first()).toBeVisible();
  // gated add-track field also appears (manual fields live behind "Mais opções" in the inline add)
  await openAdd(page);
  await expect(page.getByPlaceholder('Link do Spotify ou URI da faixa (opcional)')).toBeVisible();
});
