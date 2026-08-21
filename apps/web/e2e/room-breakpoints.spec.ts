import { expect, test, type Page } from '@playwright/test';
import { proxyConnectionToken } from './connectionTokenProxy';

/**
 * Guards the tablet range against regressing to single column (#288).
 *
 * The viewport meta added in #248 is what exposed this: before it, mobile
 * browsers laid out at ~980px and scaled down, so every device landed in the
 * desktop branch and the gap could not be seen.
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
      await join(page, `e2eb${Date.now().toString(36)}`);

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
    await join(page, `e2eb${Date.now().toString(36)}`);

    await expect.poll(async () => (await geometry(page)).sideBySide).toBe(false);

    // No horizontal overflow at the narrowest supported width (#289).
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
