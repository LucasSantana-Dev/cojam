import { test, expect, type Page } from '@playwright/test';
import { proxyConnectionToken } from './connectionTokenProxy';
import { openAvatarMenu } from './helpers';

// Modo palco, part 1: the audience character. Pick on the join screen, join
// without a reconnect, see the portrait in "Ouvindo agora", and change it from
// the avatar menu so the other member sees it live.

async function openRoom(page: Page, roomId: string) {
  await proxyConnectionToken(page);
  await page.goto(`/room/${roomId}`);
  await expect(page.getByText(roomId, { exact: true })).toBeVisible();
}

const stageFace = (page: Page, name: string) =>
  page.locator('.r4-ls__member', { hasText: name }).locator('img.px-portrait');

test('a picked character shows on the join screen, in the stage for everyone, and can be changed', async ({ browser }) => {
  const roomId = `E2EP${Date.now().toString(36).toUpperCase()}`;

  const lucas = await (await browser.newContext()).newPage();
  const ana = await (await browser.newContext()).newPage();

  await openRoom(lucas, roomId);
  const picker = lucas.getByRole('radiogroup', { name: 'Escolha quem vai pra plateia' });
  await expect(picker.getByRole('radio')).toHaveCount(13);
  await picker.getByRole('radio', { name: /^Luana, / }).click();
  await expect(picker.getByRole('radio', { name: /^Luana, / })).toHaveAttribute('aria-checked', 'true');
  // The choice survives a reload (localStorage).
  await lucas.reload();
  await expect(lucas.getByRole('radio', { name: /^Luana, / })).toHaveAttribute('aria-checked', 'true');
  await lucas.getByPlaceholder('Seu nome').fill('Lucas');
  await lucas.getByRole('button', { name: 'Entrar na sala' }).click();
  await expect(lucas.getByTestId('room-me')).toContainText('Lucas');
  await expect(stageFace(lucas, 'Lucas')).toHaveAttribute('src', '/palco/characters/05-portrait.png');

  await openRoom(ana, roomId);
  await ana.getByPlaceholder('Seu nome').fill('Ana');
  await ana.getByRole('button', { name: 'Entrar na sala' }).click();
  await expect(ana.getByTestId('room-me')).toContainText('Ana');
  // A late joiner is seeded with Lucas's choice (member.characters), and the
  // image really loads (the file is served from public/).
  await expect(stageFace(ana, 'Lucas')).toHaveAttribute('src', '/palco/characters/05-portrait.png');
  await expect.poll(() => stageFace(ana, 'Lucas').evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(64);

  // Change from the avatar menu, no reconnect: Ana sees it live.
  await openAvatarMenu(lucas);
  await lucas.getByRole('button', { name: 'Trocar personagem' }).click();
  await lucas.locator('.r4-menu__chars').getByRole('radio', { name: /^Davi, / }).click();
  await expect(stageFace(lucas, 'Lucas')).toHaveAttribute('src', '/palco/characters/09-portrait.png');
  await expect(stageFace(ana, 'Lucas')).toHaveAttribute('src', '/palco/characters/09-portrait.png');
});

test('the join button is reachable by wheel on a short wide window', async ({ page }) => {
  // A 1200x600 desktop window: the join card (13 portraits) is taller than the
  // viewport, so the join screen must scroll instead of clipping the button.
  await page.setViewportSize({ width: 1200, height: 600 });
  await openRoom(page, `E2EJ${Date.now().toString(36).toUpperCase()}`);
  const join = page.getByRole('button', { name: 'Entrar na sala' });
  await expect(page.locator('.r4-joinroom')).not.toHaveCSS('overflow-y', 'hidden');
  await page.mouse.move(600, 300);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 400);
  await expect(join).toBeInViewport();
});
