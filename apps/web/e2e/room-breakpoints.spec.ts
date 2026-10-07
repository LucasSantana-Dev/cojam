import { expect, test, type Page } from '@playwright/test';
import { proxyConnectionToken } from './connectionTokenProxy';

/**
 * Guards the tablet range against regressing to single column (#288).
 *
 * The viewport meta added in #248 is what exposed this: before it, mobile
 * browsers laid out at ~980px and scaled down, so every device landed in the
 * desktop branch and the gap could not be seen.
 *
 * The 390x844 block (#289) covers the phone layout: tabs instead of a scroll
 * past every panel, no horizontal overflow, 44px targets in the header and
 * queue rows, and a chat input that stays on screen with a keyboard-sized
 * viewport.
 *
 * Asserts geometry rather than class names, so a Tailwind config change that
 * moves a breakpoint still fails here.
 */

const MIN_PANEL_WIDTH = 250; // the readability floor set in #288

const MAIN = '[data-testid="room-main-column"]';
const SIDE = '[data-testid="room-side-column"]';

/**
 * Reads the layout relationship rather than class names, so a Tailwind config
 * change that moves a breakpoint still fails here.
 */
async function geometry(page: Page) {
  const main = await page.locator(MAIN).boundingBox();
  const side = await page.locator(SIDE).boundingBox();
  if (!main || !side) return { sideBySide: false, panelWideEnough: false, mainDominant: false };
  return {
    sideBySide: Math.abs(main.y - side.y) < 4 && side.x >= main.x + main.width,
    panelWideEnough: side.width >= MIN_PANEL_WIDTH,
    mainDominant: main.width > side.width,
  };
}

/** The grid only mounts past the waiting room, so every case has to join. */
async function join(page: Page, roomId: string) {
  await proxyConnectionToken(page);
  await page.goto(`/room/${roomId}`);
  await expect(page.getByText(roomId, { exact: true })).toBeVisible();
  await page.getByPlaceholder('Your name').fill('Probe');
  await page.getByRole('button', { name: 'Join & Play' }).click();
  await expect(page.getByText('you\u2019re Probe')).toBeVisible();
}

test.describe('room layout across the tablet range', () => {
  for (const width of [768, 834, 1023]) {
    test(`is two columns at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await join(page, `E2EB${Date.now().toString(36).toUpperCase()}`);

      // Polled, not sampled once. Two transients make a single measurement
      // unreliable, and both settle on their own:
      //   - `next dev` compiles Tailwind on demand, so the first request needing
      //     a newly added `md:` rule can paint before the rule exists. Production
      //     ships the full stylesheet, so this is a dev-server artifact.
      //   - `.room-arrival` staggers a transform per column
      //     (`animation-delay: calc(var(--i) * 90ms)`), so for ~510ms the two
      //     columns sit at different points of the same animation.
      // Polling waits for the steady state rather than encoding a sleep.
      await expect
        .poll(async () => geometry(page), { timeout: 10_000 })
        .toMatchObject({
          sideBySide: true,
          panelWideEnough: true,
          mainDominant: true,
        });
    });
  }

  test('is single column at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await join(page, `E2EB${Date.now().toString(36).toUpperCase()}`);

    await expect.poll(async () => (await geometry(page)).sideBySide).toBe(false);

    // No horizontal overflow at the narrowest supported width (#289).
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Phone: 390x844 (#289)
// ---------------------------------------------------------------------------

const MIN_TARGET = 44;
const INTERACTIVE = 'a, button, input, select, textarea, [role="button"], [role="tab"]';

/** Every visible interactive element under `scope` whose box is under 44x44. */
async function undersizedTargets(page: Page, scope: string) {
  return page.evaluate(
    ({ scope, selector, min }) => {
      const out: string[] = [];
      for (const root of Array.from(document.querySelectorAll(scope))) {
        for (const el of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.width < min - 0.5 || r.height < min - 0.5) {
            const label = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 24) ?? '';
            out.push(`${el.tagName.toLowerCase()}[${label}] ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
        }
      }
      return out;
    },
    { scope, selector: INTERACTIVE, min: MIN_TARGET },
  );
}

async function noHorizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth <= window.innerWidth;
  });
}

async function addTrack(page: Page, title: string, artist: string) {
  await page.getByRole('tab', { name: 'Add' }).click();
  await page.evaluate(() => {
    const details = document.querySelector('details');
    if (details) details.open = true;
  });
  await page.getByPlaceholder('Title').fill(title);
  await page.getByPlaceholder('Artist').fill(artist);
  await page.getByRole('button', { name: 'Add to Queue' }).click();
  await page.getByRole('tab', { name: 'Queue' }).click();
  await expect(page.getByTestId('queue-title').filter({ hasText: title })).toBeVisible();
}

test.describe('room at 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('tabs, no overflow, 44px targets, chat one tap away', async ({ page }) => {
    await join(page, `e2em${Date.now().toString(36)}`);
    await expect(page.getByRole('tab', { name: 'Chat' })).toBeVisible();

    // Header is one short band, not a stack that eats the fold.
    const header = await page.locator('.room-header').boundingBox();
    expect(header?.height ?? Infinity).toBeLessThanOrEqual(150);
    expect(await undersizedTargets(page, '.room-header')).toEqual([]);
    expect(await noHorizontalOverflow(page)).toBe(true);

    await addTrack(page, 'Row One', 'Artist A');
    await addTrack(page, 'Row Two', 'Artist B');
    expect(await noHorizontalOverflow(page)).toBe(true);

    // Rows: vote + "more" toggle on the row; secondary actions open on demand.
    const row = page.getByTestId('queue-item').first();
    await expect(row.getByRole('button', { name: 'More actions' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Remove' })).toBeHidden();
    await row.getByRole('button', { name: 'More actions' }).click();
    await expect(row.getByRole('button', { name: 'Remove' })).toBeVisible();
    expect(await undersizedTargets(page, '[data-testid="queue-item"]')).toEqual([]);
    expect(await noHorizontalOverflow(page)).toBe(true);

    // Chat is reachable with a single tab switch, no scrolling past the queue.
    await page.getByRole('tab', { name: 'Chat' }).click();
    const input = page.getByLabel('Message', { exact: true });
    await expect(input).toBeVisible();
    expect(await undersizedTargets(page, '#video-panel-chat')).toEqual([]);
    await expect(page.getByTestId('queue-item').first()).toBeHidden();

    // Keyboard open: iOS/Android leave roughly half the height. Shrink the
    // viewport to model it, focus the input, and require it to stay on screen
    // above the docked tab bar.
    await page.setViewportSize({ width: 390, height: 420 });
    await input.focus();
    await input.evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
    const box = await input.boundingBox();
    const tabs = await page.locator('.audio-tabs').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(420);
    expect(box!.y + box!.height).toBeLessThanOrEqual(tabs!.y + 1);
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(await noHorizontalOverflow(page)).toBe(true);

    if (process.env.SHOT_DIR) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('tab', { name: 'Queue' }).click();
      await page.waitForTimeout(800); // rows fade in
      await page.screenshot({ path: `${process.env.SHOT_DIR}/after-queue.png` });
      await page.getByRole('tab', { name: 'Chat' }).click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${process.env.SHOT_DIR}/after-chat.png` });
      await page.getByRole('tab', { name: 'Playing' }).click();
      await page.getByRole('tab', { name: 'Playing' }).click();
      await page.screenshot({ path: `${process.env.SHOT_DIR}/after-playing.png` });
    }
  });
});
