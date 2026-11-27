import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { ScreenShareState } from '@cojam/shared';
import { ScreenSharePanelView, type ScreenShare } from './ScreenSharePanel';
import { copyStyles } from './ScreenShareFloat';
import { useStore } from '@/lib/realtime';
import { DEFAULT_QUALITY } from '@/lib/screenShare';

const live: ScreenShareState = {
  broadcasterId: 'b1',
  broadcasterName: 'Ana',
  startedAtMs: 1,
  viewerCount: 2,
  maxViewers: 5,
  locked: false,
};

const stream = (audio = true) => {
  const tracks = audio ? [{ kind: 'audio' } as MediaStreamTrack] : [];
  return { getAudioTracks: () => tracks, getVideoTracks: () => [], getTracks: () => tracks } as unknown as MediaStream;
};

function share(over: Partial<ScreenShare>): ScreenShare {
  return {
    screen: live,
    role: 'idle',
    busy: false,
    error: '',
    notice: '',
    localStream: null,
    remoteStream: null,
    viewerState: null,
    viewerIds: [],
    lastWatchedAt: null,
    isBroadcaster: false,
    quality: DEFAULT_QUALITY,
    limitation: null,
    unwatch: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    lock: vi.fn(async () => {}),
    ...over,
  } as unknown as ScreenShare;
}

// A fake Document Picture in Picture: the "window" is an iframe's.
function fakePip() {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const win = frame.contentWindow!;
  const close = vi.fn(() => win.dispatchEvent(new Event('pagehide')));
  Object.defineProperty(win, 'close', { configurable: true, value: close });
  const requestWindow = vi.fn(async () => win);
  vi.stubGlobal('documentPictureInPicture', { requestWindow });
  return { win, requestWindow, close };
}

function show(s: ScreenShare, chat?: React.ReactNode) {
  useStore.setState({ state: { roomId: 'ROOM00000001', queue: [], radioEnabled: false, version: 1, screen: live } });
  return render(
    <ScreenSharePanelView roomId="ROOM00000001" canModerate={false} isPublic={false} share={s} chat={chat} />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.querySelectorAll('iframe').forEach((f) => f.remove());
});

describe('floating windows (Go Live gaps 11 and 12)', () => {
  it('opens the viewer float with the video, the notice, the controls and the chat', async () => {
    const pip = fakePip();
    const s = share({ role: 'watching', remoteStream: stream(), viewerState: 'connected' });
    show(s, <p>chat da sala</p>);
    fireEvent.click(screen.getByRole('button', { name: 'Janela flutuante' }));
    await waitFor(() => expect(pip.requestWindow).toHaveBeenCalledWith({ width: 420, height: 640 }));
    const body = within(pip.win.document.body);
    await waitFor(() => expect(body.getByText('chat da sala')).toBeTruthy());
    expect(body.getByText(/Transmissão não moderada/)).toBeTruthy();
    expect(body.getByRole('button', { name: 'Denunciar transmissão' })).toBeTruthy();
    // The room keeps a placeholder instead of a second copy of the video.
    expect(screen.getByTestId('screen-share-floating')).toBeTruthy();
    fireEvent.click(body.getByRole('button', { name: 'Parar de assistir' }));
    expect(s.unwatch).toHaveBeenCalled();
  });

  it('closes the float from its own "Voltar para a sala"', async () => {
    const pip = fakePip();
    show(share({ role: 'watching', remoteStream: stream(), viewerState: 'connected' }));
    fireEvent.click(screen.getByRole('button', { name: 'Janela flutuante' }));
    const body = within(pip.win.document.body);
    await waitFor(() => expect(body.getByRole('button', { name: 'Voltar para a sala' })).toBeTruthy());
    fireEvent.click(body.getByRole('button', { name: 'Voltar para a sala' }));
    expect(pip.close).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('screen-share-floating')).toBeNull());
  });

  it('gives the broadcaster a mini control with the count and stop', async () => {
    const pip = fakePip();
    const s = share({ role: 'broadcasting', isBroadcaster: true, localStream: stream(false) });
    show(s);
    fireEvent.click(screen.getByRole('button', { name: 'Mini controle' }));
    const body = within(pip.win.document.body);
    await waitFor(() => expect(body.getByTestId('screen-share-float-count').textContent).toContain('2 de 5 assistindo'));
    fireEvent.click(body.getByRole('button', { name: 'Parar de compartilhar' }));
    expect(s.stop).toHaveBeenCalled();
  });

  it('offers no mini control where the browser lacks it', () => {
    show(share({ role: 'broadcasting', isBroadcaster: true, localStream: stream(false) }));
    expect(screen.queryByRole('button', { name: 'Mini controle' })).toBeNull();
  });

  it('copies the page styles into the window', () => {
    const style = document.createElement('style');
    style.textContent = '.x{}';
    document.head.appendChild(style);
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    copyStyles(document, frame.contentDocument!);
    expect(frame.contentDocument!.head.querySelector('style')?.textContent).toBe('.x{}');
    style.remove();
  });
});
