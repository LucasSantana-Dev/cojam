import { test, expect, type Page } from '@playwright/test';
import { proxyConnectionToken } from './connectionTokenProxy';
import { openAdd } from './helpers';

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
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Entrar na sala' }).click();
  await expect(page.getByTestId('room-me')).toContainText(name);
}

async function addVideo(page: Page, title: string) {
  await openAdd(page);
  await page.getByPlaceholder('Título').fill(title);
  await page.getByPlaceholder('Artista').fill('Channel');
  await page.getByPlaceholder('Link do YouTube ou ID do vídeo (opcional)').fill('https://youtu.be/abcdefghijk');
  await page.getByRole('button', { name: 'Adicionar à fila' }).click();
  // Let the add land (the room may switch layout for a video) before the next step.
  await expect(page.getByText(title, { exact: true }).first()).toBeAttached();
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
  await lucas.getByTestId('video-main-column').getByRole('button', { name: 'Tocar', exact: true }).click();
  await expect.poll(() => position(ana)).toBeGreaterThan(0);

  // Host scrubs to the middle of the 600s video (the slider max comes from the
  // player duration since hand-added links carry none).
  const slider = lucas.getByLabel('Posição da faixa');
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
  // The first add becomes the now-playing video, which the queue list does not repeat.
  await addVideo(page, 'Clip');
  await addVideo(page, 'Clip two');

  await expect(page.getByTestId('video-room')).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Painéis da sala' })).toBeVisible();
  // Adding opened the Fila tab; back to Agora, where the queue is hidden.
  await page.getByRole('tab', { name: 'Agora', exact: true }).click();

  // Pinned: still in view after scrolling the page.
  await page.evaluate(() => window.scrollTo(0, 400));
  const stage = await page.getByTestId('stage').boundingBox();
  expect(stage!.y).toBeLessThanOrEqual(1);

  // No horizontal scroll at 390px.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  // Tab targets are at least 44px tall.
  const tab = await page.getByRole('tab', { name: 'Fila', exact: true }).boundingBox();
  expect(tab!.height).toBeGreaterThanOrEqual(44);

  await expect(page.getByTestId('queue-title').first()).toBeHidden();
  await page.getByRole('tab', { name: 'Fila', exact: true }).click();
  await expect(page.getByTestId('queue-title').first()).toBeVisible();
});

test('desktop shows stage with queue beside it and no tab bar', async ({ browser }) => {
  const roomId = `E2ED${Date.now().toString(36).toUpperCase()}`;
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await join(page, roomId, 'Lucas');
  await addVideo(page, 'Clip');
  await addVideo(page, 'Clip two');

  await expect(page.getByTestId('stage')).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Painéis da sala' })).toBeHidden();
  const stage = await page.getByTestId('stage').boundingBox();
  const side = await page.getByTestId('video-side-column').boundingBox();
  expect(side!.x).toBeGreaterThanOrEqual(stage!.x + stage!.width);
  await expect(page.getByTestId('queue-title').first()).toBeVisible();
});
