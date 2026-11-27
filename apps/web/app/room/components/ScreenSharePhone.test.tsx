import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ScreenShareState } from '@cojam/shared';
import { ScreenSharePanelView, type ScreenShare } from './ScreenSharePanel';
import { useStore } from '@/lib/realtime';
import { DEFAULT_QUALITY } from '@/lib/screenShare';
import { resetVolumeProbe } from '@/lib/screenShareView';

const live: ScreenShareState = {
  broadcasterId: 'b1',
  broadcasterName: 'Ana',
  startedAtMs: 1,
  viewerCount: 1,
  maxViewers: 5,
  locked: false,
};

function share(over: Partial<ScreenShare> = {}): ScreenShare {
  return {
    screen: undefined,
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
    ...over,
  } as unknown as ScreenShare;
}

function watchingWithSound(): ScreenShare {
  const audio = { kind: 'audio' } as MediaStreamTrack;
  const stream = { getAudioTracks: () => [audio], getVideoTracks: () => [], getTracks: () => [audio] };
  return share({
    screen: live,
    role: 'watching',
    remoteStream: stream as unknown as MediaStream,
    viewerState: 'connected',
  });
}

function show(s: ScreenShare, canModerate = false) {
  useStore.setState({
    state: { roomId: 'ROOM00000001', queue: [], radioEnabled: false, version: 1, screen: s.screen },
  });
  return render(<ScreenSharePanelView roomId="ROOM00000001" canModerate={canModerate} isPublic={false} share={s} />);
}

afterEach(() => {
  cleanup();
  resetVolumeProbe();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
});

describe('screen share on phones and with the keyboard (Go Live gaps 6, 7, 10)', () => {
  it('tells a host on a phone that sharing works on a computer', () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} });
    show(share(), true);
    expect(screen.getByTestId('screen-share-no-capture').textContent).toContain('computador');
    expect(screen.queryByRole('button', { name: 'Compartilhar tela' })).toBeNull();
  });

  it('says nothing to members who cannot share anyway', () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} });
    show(share(), false);
    expect(screen.queryByTestId('screen-share-no-capture')).toBeNull();
  });

  it('hides the volume slider where volume is read only', () => {
    const real = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string, opts?: ElementCreationOptions) => {
      const el = real(tag, opts);
      if (tag === 'video') Object.defineProperty(el, 'volume', { get: () => 1, set: () => {} });
      return el;
    });
    show(watchingWithSound());
    expect(screen.queryByRole('slider', { name: 'Volume da transmissão' })).toBeNull();
  });

  it('keeps the slider where volume works', () => {
    show(watchingWithSound());
    expect(screen.getByRole('slider', { name: 'Volume da transmissão' })).toBeTruthy();
  });

  it('M toggles the sound, and typing in a field does not', () => {
    show(watchingWithSound());
    const before = screen.getByRole('button', { name: /Tocar som|Tirar som/ }).getAttribute('aria-label');
    fireEvent.keyDown(window, { key: 'm' });
    const after = screen.getByRole('button', { name: /Tocar som|Tirar som/ }).getAttribute('aria-label');
    expect(after).not.toBe(before);
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'm' });
    expect(screen.getByRole('button', { name: /Tocar som|Tirar som/ }).getAttribute('aria-label')).toBe(after);
    input.remove();
  });

  it('F and a double click on the video go fullscreen', () => {
    const req = vi.fn(async () => {});
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: req });
    show(watchingWithSound());
    fireEvent.keyDown(window, { key: 'f' });
    expect(req).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(screen.getByTestId('screen-video'));
    expect(req).toHaveBeenCalledTimes(2);
    delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
  });
});
