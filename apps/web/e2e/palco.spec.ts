import { expect, test, type Page } from '@playwright/test';

// Modo palco, part 2: the stage view of a live room. The room's own YouTube
// player is lifted over the stage screen: at least 200x200 px, hit-testable,
// and no name tag, chat bubble, HUD, panel or top bar touches its box, with
// each panel (Palco / Fila / Chat) open, at 390x844 and 1440x900. Uses the dev
// fixture (?fixture=room&yt=1: a stand-in with the real #youtube-player id and
// slot), like yt-pinned.spec.ts. PALCO_SHOTS_DIR, when set, receives screenshots.

const FIXTURE = '/room/SALABIA?fixture=room&yt=1';
const SHOTS = process.env.PALCO_SHOTS_DIR;
const SHOT_PREFIX = process.env.PALCO_SHOT_PREFIX ?? 'palco';

type Box = { x: number; y: number; width: number; height: number };

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function playerBox(page: Page): Promise<Box> {
  const box = await page.locator('#youtube-player').boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

// Every visible overlay that must stay off the player.
async function overlayBoxes(page: Page): Promise<Array<{ what: string; box: Box }>> {
  return page.evaluate(() => {
    const out: Array<{ what: string; box: { x: number; y: number; width: number; height: number } }> = [];
    const sel = '.palco-tag, .palco-bubble, .palco__more, .palco-board, [data-testid="palco-hud"], .palco__panel, .room-header';
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      out.push({ what: `${el.className} ${el.textContent?.slice(0, 20) ?? ''}`, box: { x: r.x, y: r.y, width: r.width, height: r.height } });
    });
    return out;
  });
}

async function expectPlayerClear(page: Page) {
  const box = await playerBox(page);
  // YouTube API terms: at least 200x200, always (on phones: full width, owner decision A).
  expect(box.width).toBeGreaterThanOrEqual(200);
  expect(box.height).toBeGreaterThanOrEqual(200);
  // Fully on screen.
  const vp = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
  // Nothing drawn over its centre or corners.
  const hits = await page.evaluate(() => {
    const el = document.getElementById('youtube-player')!;
    const r = el.getBoundingClientRect();
    const pts: Array<[number, number]> = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 2, r.top + 2],
      [r.right - 2, r.top + 2],
      [r.left + 2, r.bottom - 2],
      [r.right - 2, r.bottom - 2],
    ];
    return pts.map(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit && el.contains(hit) ? 'ok' : `covered by ${(hit as HTMLElement | null)?.className ?? 'nothing'}`;
    });
  });
  expect(hits).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
  const tags = await overlayBoxes(page);
  expect(tags.length).toBeGreaterThan(0);
  for (const t of tags) expect(overlaps(t.box, box), t.what).toBe(false);
}

async function openPalco(page: Page) {
  await page.goto(FIXTURE);
  await page.evaluate(() => window.localStorage.removeItem('cojam.palco.view'));
  await page.reload();
  const toggle = page.getByRole('button', { name: 'Modo palco' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('palco')).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('palco')).toBeVisible();
  await expect(page.locator('.palco__gl canvas, .palco__still')).toHaveCount(1);
  // The booths rise in and the tags settle.
  await expect(page.locator('.palco-tag--dj').first()).toBeVisible();
  await page.waitForTimeout(1200);
}

for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test.describe(`Modo palco at ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp });

    test('the player sits on the stage screen, uncovered, with every panel', async ({ page }) => {
      await openPalco(page);
      for (const [tab, panel] of [['Palco', null], [/^Fila/, 'queue-panel'], ['Chat', null]] as const) {
        await page.getByRole('tab', { name: tab }).click();
        if (panel) await expect(page.getByTestId(panel)).toHaveCount(1);
        if (panel) await expect(page.getByTestId(panel)).toBeVisible();
        if (tab === 'Chat') await expect(page.locator('.palco__panel .chat-panel')).toBeVisible();
        await page.waitForTimeout(400);
        await expectPlayerClear(page);
        if (SHOTS) {
          // The Next dev indicator is not part of the page.
          await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
          const name = typeof tab === 'string' ? tab.toLowerCase() : 'fila';
          await page.screenshot({ path: `${SHOTS}/${SHOT_PREFIX}-${vp.width}x${vp.height}-${name}.png` });
        }
      }
      // Never two copies of the queue or the chat.
      await expect(page.getByTestId('queue-panel')).toHaveCount(0);
    });

    test('the HUD carries volume, Ouvir no and the host transport, 44 px targets, inside the view', async ({ page }) => {
      await openPalco(page);
      const hud = page.getByTestId('palco-hud');
      const ctrls = hud.getByRole('group', { name: 'Controles da música' });
      await expect(ctrls).toBeVisible();
      await expect(ctrls.getByRole('slider', { name: 'Volume' })).toBeVisible();
      await expect(ctrls.getByRole('button', { name: 'Silenciar' })).toBeVisible();
      // The fixture room has no auth: everyone controls, so the transport shows.
      await expect(ctrls.getByRole('button', { name: /^(Pausar|Tocar)$/ })).toBeVisible();
      await expect(ctrls.getByRole('button', { name: 'Próxima faixa' })).toBeVisible();
      if (process.env.NEXT_PUBLIC_FEATURE_SPOTIFY === 'on') await expect(ctrls.getByRole('group', { name: 'Ouvir no' })).toBeVisible();
      const vpw = page.viewportSize()!;
      const player = await playerBox(page);
      for (const b of await hud.getByRole('button').all()) {
        if (!(await b.isVisible())) continue;
        const r = (await b.boundingBox())!;
        const name = (await b.getAttribute('aria-label')) ?? (await b.textContent());
        expect(r.height, `${name} height`).toBeGreaterThanOrEqual(44);
        expect(r.width, `${name} width`).toBeGreaterThanOrEqual(44);
        expect(r.x + r.width, `${name} inside`).toBeLessThanOrEqual(vpw.width);
        expect(overlaps(r, player), `${name} off the player`).toBe(false);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await expectPlayerClear(page);
    });

    test('the "A seguir" board lists the next tracks under the player, clear of every tag', async ({ page }) => {
      await openPalco(page);
      const board = page.getByRole('region', { name: 'A seguir' });
      await expect(board).toBeVisible();
      const rows = await board.getByRole('listitem').count();
      expect(rows).toBeGreaterThanOrEqual(1);
      expect(rows).toBeLessThanOrEqual(3);
      const b = (await board.boundingBox())!;
      const player = await playerBox(page);
      expect(overlaps(b, player)).toBe(false);
      expect(b.y).toBeGreaterThanOrEqual(player.y + player.height);
      for (const t of await overlayBoxes(page)) {
        if (!t.what.startsWith('palco-tag')) continue;
        expect(overlaps(t.box, b), t.what).toBe(false);
      }
      await expectPlayerClear(page);
    });

    test('the view is remembered and the player is never remounted by the switch', async ({ page }) => {
      await openPalco(page);
      await page.evaluate(() => {
        (document.getElementById('youtube-player') as HTMLElement & { palcoMark?: number }).palcoMark = 7;
      });
      const toggle = page.getByRole('button', { name: 'Modo palco' });
      await toggle.click();
      await expect(page.getByTestId('palco')).toHaveCount(0);
      await toggle.click();
      await expect(page.getByTestId('palco')).toBeVisible();
      expect(await page.evaluate(() => (document.getElementById('youtube-player') as HTMLElement & { palcoMark?: number }).palcoMark)).toBe(7);
      await page.reload();
      await expect(page.getByRole('button', { name: 'Modo palco' })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('palco')).toBeVisible();
    });
  });
}
