import { test, expect, type Page } from '@playwright/test';
import { proxyConnectionToken } from './connectionTokenProxy';

// E1 video co-watch (#258): two browsers in a video room converge on the
// host's seek, and the phone layout pins the stage with tabbed panels.
//
// The YouTube IFrame API is replaced by a deterministic clock-based stub: the
// real player needs the network and cannot be asserted to the second. The
// stub exposes its position as window.__ytPositionMs so the test reads what a
// viewer would be watching.

const DRIFT_THRESHOLD_MS = 1000; // lib/playbackSync.ts

const YT_STUB = `
window.YT = { Player: function (id, opts) {
  var el = document.getElementById(id);
  var base = 0, startedAt = 0, playing = false;
  var self = this;
  function pos() { return base + (playing ? Date.now() - startedAt : 0); }
  window.__ytPositionMs = pos;
  this.playVideo = function () { if (!playing) { startedAt = Date.now(); playing = true; } };
  this.pauseVideo = function () { base = pos(); playing = false; };
  this.seekTo = function (s) { base = s * 1000; startedAt = Date.now(); };
  this.getCurrentTime = function () { return pos() / 1000; };
  this.getDuration = function () { return 600; };
  this.loadVideoById = function () { base = 0; startedAt = Date.now(); playing = true; };
  if (el) { el.setAttribute('data-stub', 'yt'); el.style.minHeight = '100px'; }
  setTimeout(function () { opts.events && opts.events.onReady && opts.events.onReady(); }, 0);
} };
setTimeout(function () { window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(); }, 0);
`;

// Web flags are build/runtime config, off for every other spec. Append an
// override to the real /env.js so only this spec's pages see sync + video.
async function enableVideoFlags(page: Page) {
  await page.route('**/env.js', async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    await route.fulfill({
      response: res,
      body:
        body +
        ';window.__COJAM_ENV__.features=Object.assign({},window.__COJAM_ENV__.features,{sync:true,video:true});',
    });
  });
}

async function stubYouTube(page: Page) {
  await enableVideoFlags(page);
  await page.route('**/iframe_api', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: YT_STUB }),
  );
}

async function join(page: Page, roomId: string, name: string) {
  await stubYouTube(page);
  await proxyConnectionToken(page);
  await page.goto(`/room/${roomId}`);
  await expect(page.getByText(roomId, { exact: true })).toBeVisible();
  await page.getByPlaceholder('Your name').fill(name);
  await page.getByRole('button', { name: 'Join & Play' }).click();
  await expect(page.getByText(`you’re ${name}`)).toBeVisible();
}

async function addVideo(page: Page, title: string) {
  // Phone width (#289): the audio room keeps the add form behind its Add tab.
  const addTab = page.getByRole('tab', { name: 'Add' });
  if (await addTab.isVisible()) await addTab.click();
  await page.evaluate(() => {
    const details = document.querySelector('details');
    if (details) details.open = true;
  });
  await page.getByPlaceholder('Title').fill(title);
  await page.getByPlaceholder('Artist').fill('Channel');
  await page.getByPlaceholder('YouTube link or video ID (optional)').fill('https://youtu.be/abcdefghijk');
  await page.getByRole('button', { name: 'Add to Queue' }).click();
}

const position = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ytPositionMs?: () => number }).__ytPositionMs?.() ?? -1);

test('host seek converges on the member within the drift threshold', async ({ browser }) => {
  const roomId = `E2EV${Date.now().toString(36).toUpperCase()}`;
  const lucas = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const ana = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

  await join(lucas, roomId, 'Lucas');
  await join(ana, roomId, 'Ana');

  await addVideo(lucas, 'Clip');
  await expect(lucas.getByTestId('video-room')).toBeVisible();
  await expect(ana.getByTestId('video-room')).toBeVisible();
  await expect(lucas.getByTestId('stage')).toBeVisible();

  // Host starts playback; both stubs run.
  await lucas.getByTestId('video-main-column').getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => position(ana)).toBeGreaterThan(0);

  // Host scrubs to the middle of the 600s video (the slider max comes from the
  // player duration since hand-added links carry none).
  const slider = lucas.getByLabel('Track position');
  await expect(slider).toHaveAttribute('max', '600000');
  await slider.click({ position: { x: (await slider.boundingBox())!.width / 2, y: 4 } });

  await expect
    .poll(async () => {
      const [h, m] = [await position(lucas), await position(ana)];
      return h > 250_000 && Math.abs(h - m) <= DRIFT_THRESHOLD_MS;
    }, { timeout: 15_000 })
    .toBe(true);
});

test('phone layout pins the stage and puts the panels in tabs', async ({ browser }) => {
  const roomId = `E2EM${Date.now().toString(36).toUpperCase()}`;
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await join(page, roomId, 'Lucas');
  await addVideo(page, 'Clip');

  await expect(page.getByTestId('video-room')).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Room panels' })).toBeVisible();

  // Pinned: still in view after scrolling the page.
  await page.evaluate(() => window.scrollTo(0, 400));
  const stage = await page.getByTestId('stage').boundingBox();
  expect(stage!.y).toBeLessThanOrEqual(1);

  // No horizontal scroll at 390px.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  // Tab targets are at least 44px tall.
  const tab = await page.getByRole('tab', { name: 'Queue' }).boundingBox();
  expect(tab!.height).toBeGreaterThanOrEqual(44);

  await expect(page.getByTestId('queue-title').first()).toBeHidden();
  await page.getByRole('tab', { name: 'Queue' }).click();
  await expect(page.getByTestId('queue-title').first()).toBeVisible();
});

test('desktop shows stage with queue beside it and no tab bar', async ({ browser }) => {
  const roomId = `E2ED${Date.now().toString(36).toUpperCase()}`;
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await join(page, roomId, 'Lucas');
  await addVideo(page, 'Clip');

  await expect(page.getByTestId('stage')).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Room panels' })).toBeHidden();
  const stage = await page.getByTestId('stage').boundingBox();
  const side = await page.getByTestId('video-side-column').boundingBox();
  expect(side!.x).toBeGreaterThanOrEqual(stage!.x + stage!.width);
  await expect(page.getByTestId('queue-title').first()).toBeVisible();
});
