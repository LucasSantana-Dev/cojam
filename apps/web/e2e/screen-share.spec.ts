import { test, expect, type Page } from '@playwright/test';
import { proxyConnectionToken } from './connectionTokenProxy';

// Screen share v1 (#310): the host shares, a member explicitly chooses to
// watch and receives real WebRTC frames, then both sides tear down.
//
// The browser picker cannot be driven headless, so getDisplayMedia is
// replaced with an animated canvas stream. Everything after it is real: the
// RPCs, the server's signaling relay and a peer connection between the two
// pages over host candidates (no STUN in e2e; playwright.config.ts turns off
// the mDNS address hiding that would stop them resolving each other).

const FAKE_DISPLAY = `
navigator.mediaDevices.getDisplayMedia = async function () {
  var c = document.createElement('canvas');
  c.width = 640; c.height = 360;
  var ctx = c.getContext('2d');
  var n = 0;
  setInterval(function () {
    n++;
    ctx.fillStyle = n % 2 ? 'oklch(0.55 0.25 295)' : 'oklch(0.75 0.2 150)';
    ctx.fillRect(0, 0, c.width, c.height);
  }, 100);
  return c.captureStream(15);
};
`;

// Web flags are off for every other spec: only this spec's pages see the
// share UI, with STUN disabled so the peers use host candidates.
async function enableScreenShare(page: Page) {
  await page.route('**/env.js', async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    await route.fulfill({
      response: res,
      body:
        body +
        ';window.__COJAM_ENV__.stunUrls="";window.__COJAM_ENV__.features=Object.assign({},window.__COJAM_ENV__.features,{screenShare:true});',
    });
  });
}

async function join(page: Page, roomId: string, name: string) {
  await enableScreenShare(page);
  await page.addInitScript(FAKE_DISPLAY);
  await proxyConnectionToken(page);
  await page.goto(`/room/${roomId}`);
  await expect(page.getByText(roomId, { exact: true })).toBeVisible();
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Entrar na sala' }).click();
  await expect(page.getByTestId('room-me')).toContainText(name);
}

// Screen share needs the 12-character room id format.
function newRoomId(): string {
  return `E2ES${Date.now().toString(36).toUpperCase()}`.padEnd(12, '0').slice(0, 12);
}

test('host shares, a member watches real frames, then both tear down', async ({ browser }) => {
  const roomId = newRoomId();
  const hostCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const viewer = await viewerCtx.newPage();
  try {
    await join(host, roomId, 'Ana');
    await join(viewer, roomId, 'Bia');

    // Only the host is offered sharing.
    await expect(viewer.getByRole('button', { name: 'Compartilhar tela' })).toHaveCount(0);

    await host.getByRole('button', { name: 'Compartilhar tela' }).click();
    await host.getByRole('checkbox', { name: /anos ou mais/ }).check();
    await host.getByRole('button', { name: 'Escolher o que compartilhar' }).click();
    await expect(host.getByText('Você está compartilhando a tela')).toBeVisible();
    await expect(host.getByTestId('screen-share-count')).toHaveText('0 de 5 assistindo');

    // Nothing is received until the member chooses to watch.
    await expect(viewer.getByText('Ana está compartilhando a tela')).toBeVisible();
    await expect(viewer.getByTestId('screen-video')).toHaveCount(0);
    await viewer.getByRole('button', { name: 'Assistir' }).click();
    // Watching asks for the same age affirmation as sharing (owner decision Q1).
    const confirm = viewer.getByRole('dialog');
    await confirm.getByRole('checkbox', { name: /anos ou mais/ }).check();
    await confirm.getByRole('button', { name: 'Assistir' }).click();

    await expect(viewer.getByTestId('screen-share-notice')).toHaveText(
      'Transmissão não moderada. O CoJam não vê nem grava o que é compartilhado.',
    );
    await expect(host.getByTestId('screen-share-count')).toHaveText('1 de 5 assistindo');
    await expect
      .poll(
        () =>
          viewer.evaluate(() => {
            const v = document.querySelector('[data-testid="screen-video"]') as HTMLVideoElement | null;
            return v ? v.videoWidth : 0;
          }),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    await viewer.getByRole('button', { name: 'Parar de assistir' }).click();
    await expect(viewer.getByTestId('screen-video')).toHaveCount(0);
    await expect(host.getByTestId('screen-share-count')).toHaveText('0 de 5 assistindo');

    await host.getByRole('button', { name: 'Parar de compartilhar' }).click();
    await expect(viewer.getByText('Ana está compartilhando a tela')).toHaveCount(0);
    await expect(host.getByRole('button', { name: 'Compartilhar tela' })).toBeVisible();
  } finally {
    await hostCtx.close();
    await viewerCtx.close();
  }
});
