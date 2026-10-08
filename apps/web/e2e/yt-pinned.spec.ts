import { expect, test, type Page } from '@playwright/test';

// The YouTube player (the cover slot) must stay visible, at least 200x200 and
// unobscured, on a phone: pinned above the Fila and Chat tabs, never under the
// avatar menu's stacking, never under a drawer. Uses the dev fixture
// (?fixture=room&yt=1: a stand-in with the real #youtube-player id and slot).
// With the avatar menu open the menu itself overlaps the card by design, so the
// menu case asserts the menu items are on top; the player hit test is made with
// the menu closed and with the drawer open.

const FIXTURE = '/room/SALABIA?fixture=room&yt=1';

type Hit = 'ok' | 'offscreen' | string;

// Is the point at the centre of `selector` actually hitting it (or a child)?
function centreHit(page: Page, selector: string): Promise<Hit> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return 'missing';
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (y < 0 || y > window.innerHeight) return 'offscreen';
    const hit = document.elementFromPoint(x, y);
    return hit && el.contains(hit) ? 'ok' : `covered by ${hit?.className ?? 'nothing'}`;
  }, selector);
}

async function expectCover(page: Page, allowOffscreen: boolean) {
  const box = await page.locator('.r4-cover--media').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(200);
  expect(box!.height).toBeGreaterThanOrEqual(200);
  const hit = await centreHit(page, '.r4-cover--media');
  if (allowOffscreen && hit === 'offscreen') return;
  expect(hit).toBe('ok');
}

async function selectTab(page: Page, name: 'Agora' | 'Fila' | 'Chat') {
  await page.getByRole('tab', { name, exact: true }).click();
}

// Items of the open avatar menu answer a click at their centre (nothing over them).
async function expectMenuHitTestable(page: Page) {
  for (const name of ['Trocar nome', 'Sair da sala']) {
    const hit = await page.evaluate((label) => {
      const btn = Array.from(document.querySelectorAll<HTMLElement>('.r4-menu--user button')).find((b) => b.textContent?.includes(label));
      if (!btn) return 'missing';
      const r = btn.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el && btn.contains(el) ? 'ok' : `covered by ${(el as HTMLElement | null)?.className ?? 'nothing'}`;
    }, name);
    expect(hit, name).toBe('ok');
  }
}

test.describe('YouTube player on a phone (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const tab of ['Agora', 'Fila', 'Chat'] as const) {
    for (const scrollY of [0, 400]) {
      test(`${tab} at scrollY ${scrollY}: player visible, menu on top, drawer below it`, async ({ page }) => {
        await page.goto(FIXTURE);
        await expect(page.locator('.r4-cover--media')).toBeVisible();
        if (tab !== 'Agora') await selectTab(page, tab);
        await page.evaluate((y) => window.scrollTo(0, y), scrollY);
        // On Agora the card scrolls away with the page; the other tabs pin it.
        const allowOffscreen = tab === 'Agora' && scrollY > 0;
        await expectCover(page, allowOffscreen);

        // Avatar menu open: its items are on top (the pinned card must not cover them).
        await page.getByRole('button', { name: /^Menu de/ }).click();
        await expect(page.locator('.r4-menu--user')).toBeVisible();
        await expectMenuHitTestable(page);
        await page.keyboard.press('Escape');
        await expect(page.locator('.r4-menu--user')).toBeHidden();

        // Letra drawer open: the sheet starts below the player, the player stays hit-testable.
        await page.evaluate(() => window.scrollTo(0, 0));
        await selectTab(page, 'Agora');
        await page.getByRole('button', { name: 'Mais opções da faixa' }).click();
        await page.getByRole('button', { name: 'Letra' }).click();
        const sheet = page.locator('.lyrics-panel');
        await expect(sheet).toBeVisible();
        if (tab !== 'Agora') {
          // The tab bar sits under the sheet; switch the way a keyboard user would.
          await page.evaluate((id) => document.getElementById(id)?.click(), `video-tab-${tab === 'Fila' ? 'queue' : 'chat'}`);
        }
        await page.evaluate((y) => window.scrollTo(0, y), scrollY);
        await page.waitForTimeout(300);
        await expectCover(page, allowOffscreen);
        const cover = await page.locator('.r4-cover--media').boundingBox();
        const sheetBox = await sheet.boundingBox();
        if (cover && cover.y + cover.height > 0 && cover.y < 844) {
          expect(sheetBox!.y).toBeGreaterThanOrEqual(cover.y + cover.height - 1);
        }
        await expect(page.locator('.lyrics-backdrop')).toBeHidden();
      });
    }
  }
});

test.describe('shell at 1024x768', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('two columns, no horizontal scroll, menu on top, drawer is a side panel without a scrim', async ({ page }) => {
    await page.goto('/room/SALABIA?fixture=room');
    await expect(page.getByTestId('queue-panel')).toBeVisible();
    await expect(page.locator('.chat-panel')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.getByRole('button', { name: /^Menu de/ }).click();
    await expectMenuHitTestable(page);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Mais opções da faixa' }).click();
    await page.getByRole('button', { name: 'Letra' }).click();
    const sheet = await page.locator('.lyrics-panel').boundingBox();
    expect(sheet!.x + sheet!.width).toBeGreaterThanOrEqual(1023);
    expect(sheet!.x).toBeGreaterThan(300);
    await expect(page.locator('.lyrics-backdrop')).toBeHidden();
  });
});
