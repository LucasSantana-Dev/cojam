import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react';
import type { RoomState, ScreenShareState } from '@cojam/shared';
import { IDLE_MS, ScreenSharePanel, ScreenSharePanelView, liveFor, type ScreenShare } from './ScreenSharePanel';
import { useStore } from '@/lib/realtime';
import { affirmAge } from '@/lib/ageGate';
import { DEFAULT_QUALITY } from '@/lib/screenShare';

// The RPC wrappers are mocked; the panel drives the real store, so what it
// shows follows state.screen exactly like in the app.
const rpc = vi.hoisted(() => ({
  screenStart: vi.fn(async () => {}),
  screenStop: vi.fn(async () => {}),
  screenWatch: vi.fn(async () => 'b1'),
  screenUnwatch: vi.fn(async () => {}),
  screenLock: vi.fn(async () => {}),
  screenRefuse: vi.fn(async () => {}),
  rtcSignal: vi.fn(async () => {}),
}));

vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  ...rpc,
}));

class StubPC {
  onicecandidate = null;
  ontrack = null;
  onconnectionstatechange = null;
  connectionState = 'new';
  close() {}
}

const live = (over: Partial<ScreenShareState> = {}): ScreenShareState => ({
  broadcasterId: 'b1',
  broadcasterName: 'Ana',
  startedAtMs: 1,
  viewerCount: 1,
  maxViewers: 5,
  locked: false,
  ...over,
});

const state = (over: Partial<RoomState> = {}): RoomState => ({
  roomId: 'ROOM00000001',
  queue: [],
  radioEnabled: false,
  version: 1,
  ...over,
});

function seed(over: Partial<RoomState> = {}, clientId = 'me') {
  useStore.setState({ state: state(over), clientId, connected: true, connections: [] });
}

function renderPanel(canModerate = false, isPublic = false) {
  return render(<ScreenSharePanel roomId="ROOM00000001" canModerate={canModerate} isPublic={isPublic} />);
}

beforeEach(() => {
  Object.values(rpc).forEach((m) => m.mockClear());
  vi.stubGlobal('RTCPeerConnection', StubPC);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia: vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError'); }) },
  });
  try {
    localStorage.clear();
  } catch {
    /* storage unavailable */
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ScreenSharePanel', () => {
  it('offers sharing to the host of a private room only', () => {
    seed();
    const { unmount } = renderPanel(true, false);
    expect(screen.getByRole('button', { name: 'Compartilhar tela' })).toBeTruthy();
    unmount();

    renderPanel(true, true);
    expect(screen.queryByRole('button', { name: 'Compartilhar tela' })).toBeNull();
    cleanup();

    renderPanel(false, false);
    expect(screen.queryByTestId('screen-share-idle')).toBeNull();
  });

  it('asks for the age affirmation before the browser picker opens', async () => {
    seed();
    renderPanel(true);
    fireEvent.click(screen.getByRole('button', { name: 'Compartilhar tela' }));
    const go = screen.getByRole('button', { name: 'Escolher o que compartilhar' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /anos ou mais/ }));
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    // The picker was cancelled: nothing reaches the server.
    await waitFor(() => expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalled());
    expect(rpc.screenStart).not.toHaveBeenCalled();
  });

  it('never watches on its own: a live share is a card with "Assistir" and the address disclosure', () => {
    seed({ screen: live() });
    renderPanel();
    expect(screen.getByText('Ana está compartilhando a tela')).toBeTruthy();
    expect(screen.getByText(/vocês verão o endereço de rede um do outro/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Assistir' }) as HTMLButtonElement).disabled).toBe(false);
    expect(rpc.screenWatch).not.toHaveBeenCalled();
  });

  it('disables "Assistir" when the share is locked or full', () => {
    seed({ screen: live({ locked: true }) });
    const { unmount } = renderPanel();
    expect((screen.getByRole('button', { name: 'Assistir' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/entrada desta transmissão está fechada/)).toBeTruthy();
    unmount();

    seed({ screen: live({ viewerCount: 5 }) });
    renderPanel();
    expect((screen.getByRole('button', { name: 'Assistir' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/está cheia/)).toBeTruthy();
  });

  it('asks for the age affirmation before watching, then watches (owner decision Q1)', async () => {
    seed({ screen: live() });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Assistir' }));
    expect(rpc.screenWatch).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    const go = within(dialog).getByRole('button', { name: 'Assistir' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /anos ou mais/ }));
    fireEvent.click(go);
    await waitFor(() => expect(rpc.screenWatch).toHaveBeenCalledWith('ROOM00000001'));
  });

  it('watching shows the notice that cannot be closed, and "Parar de assistir" unwatches', async () => {
    affirmAge();
    seed({ screen: live() });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Assistir' }));
    await waitFor(() => expect(rpc.screenWatch).toHaveBeenCalledWith('ROOM00000001'));
    expect(screen.getByTestId('screen-share-notice').textContent).toBe(
      'Transmissão não moderada. O CoJam não vê nem grava o que é compartilhado.',
    );
    expect(screen.getByRole('button', { name: 'Denunciar transmissão' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Parar de assistir' }));
    await waitFor(() => expect(rpc.screenUnwatch).toHaveBeenCalledWith('ROOM00000001'));
    expect(screen.queryByTestId('screen-share-notice')).toBeNull();
  });

  it('opens large over the page, with "Reduzir" back to the room and fullscreen offered', async () => {
    affirmAge();
    seed({ screen: live() });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Assistir' }));
    // The large view lives in a portal on the body, so the node is queried again after each switch.
    const view = () => screen.getByTestId('screen-share-watching');
    await screen.findByTestId('screen-share-watching');
    expect(view().className).toContain('screen-share--theater');
    expect(view().parentElement).toBe(document.body);
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByRole('button', { name: 'Tela cheia' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reduzir' }));
    expect(view().className).not.toContain('screen-share--theater');
    expect(view().parentElement).not.toBe(document.body);
    expect(document.body.style.overflow).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Ampliar' }));
    expect(view().className).toContain('screen-share--theater');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(view().className).not.toContain('screen-share--theater');
  });

  it('drops the video when the share disappears from the room state', async () => {
    affirmAge();
    seed({ screen: live() });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Assistir' }));
    await waitFor(() => expect(screen.getByTestId('screen-share-watching')).toBeTruthy());
    useStore.setState({ state: state() });
    await waitFor(() => expect(screen.queryByTestId('screen-share-watching')).toBeNull());
    expect(screen.getByText('A transmissão terminou.')).toBeTruthy();
  });

  it('lets the host stop or lock someone else’s share', async () => {
    seed({ screen: live() });
    renderPanel(true);
    fireEvent.click(screen.getByRole('button', { name: 'Fechar entrada' }));
    await waitFor(() => expect(rpc.screenLock).toHaveBeenCalledWith('ROOM00000001', true));
    fireEvent.click(screen.getByRole('button', { name: 'Encerrar compartilhamento' }));
    await waitFor(() => expect(rpc.screenStop).toHaveBeenCalledWith('ROOM00000001'));
  });

  it('shows the broadcaster their viewer count', () => {
    seed({ screen: live({ broadcasterId: 'me', viewerCount: 2 }) }, 'me');
    renderPanel(true);
    expect(screen.getByText('Você está compartilhando a tela')).toBeTruthy();
    expect(screen.getByTestId('screen-share-count').textContent).toBe('2 de 5 assistindo');
  });

  it('tells how long the share has been live and how many watch', () => {
    expect(liveFor(1_000, 1_000)).toBe('Ao vivo agora');
    expect(liveFor(5_000, 1_000)).toBe('Ao vivo agora');
    expect(liveFor(0, 12 * 60_000)).toBe('Ao vivo há 12 min');
    expect(liveFor(0, 60 * 60_000)).toBe('Ao vivo há 1 h');
    expect(liveFor(0, 95 * 60_000)).toBe('Ao vivo há 1 h 35 min');
    seed({ screen: live({ startedAtMs: Date.now() - 3 * 60_000, viewerCount: 2 }) });
    renderPanel();
    expect(screen.getByTestId('screen-share-card-info').textContent).toBe('Ao vivo há 3 min · 2 de 5 assistindo');
  });

  function watchingShare(over: Partial<ScreenShare> = {}) {
    const audio = { kind: 'audio' } as MediaStreamTrack;
    const stream = { getAudioTracks: () => [audio], getVideoTracks: () => [], getTracks: () => [audio] };
    return {
      screen: live(),
      role: 'watching',
      busy: false,
      error: '',
      notice: '',
      localStream: null,
      remoteStream: stream as unknown as MediaStream,
      viewerState: 'connected',
      viewerIds: [],
      lastWatchedAt: null,
      isBroadcaster: false,
      quality: DEFAULT_QUALITY,
      limitation: null,
      ...over,
    } as unknown as ScreenShare;
  }

  function renderWatching(share: ScreenShare, chat?: React.ReactNode) {
    return render(
      <ScreenSharePanelView roomId="ROOM00000001" canModerate={false} isPublic={false} share={share} chat={chat} />,
    );
  }

  it('starts with sound, and the volume slider turns it back on and remembers the level', () => {
    seed({ screen: live() });
    renderWatching(watchingShare());
    const slider = screen.getByRole('slider', { name: 'Volume da transmissão' }) as HTMLInputElement;
    const video = screen.getByTestId('screen-video') as HTMLVideoElement;
    // Choosing "Assistir" is the click that lets the video play with sound.
    expect(screen.getByRole('button', { name: 'Tirar som' })).toBeTruthy();
    expect(video.muted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Tirar som' }));
    expect(slider.value).toBe('0');
    expect(video.muted).toBe(true);
    fireEvent.change(slider, { target: { value: '0.4' } });
    expect(screen.getByRole('button', { name: 'Tirar som' })).toBeTruthy();
    expect(slider.value).toBe('0.4');
    expect(localStorage.getItem('cojam.screenVolume')).toBe('0.4');
    expect(video.muted).toBe(false);
    expect(video.volume).toBeCloseTo(0.4);
  });

  it('falls back to muted when the browser refuses to play with sound', async () => {
    seed({ screen: live() });
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(function (this: HTMLMediaElement) {
        return this.muted ? Promise.resolve() : Promise.reject(new DOMException('no', 'NotAllowedError'));
      });
    try {
      renderWatching(watchingShare());
      expect(await screen.findByRole('button', { name: 'Tocar som' })).toBeTruthy();
      expect((screen.getByTestId('screen-video') as HTMLVideoElement).muted).toBe(true);
    } finally {
      play.mockRestore();
    }
  });

  it('keeps the room chat beside the large view, and remembers when it is closed', () => {
    seed({ screen: live() });
    localStorage.setItem('cojam.screenChat', '1');
    renderWatching(watchingShare(), <div className="chat-panel">chat da sala</div>);
    const view = screen.getByTestId('screen-share-watching');
    expect(view.className).toContain('screen-share--with-chat');
    expect(screen.getByTestId('screen-share-chat').textContent).toBe('chat da sala');
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(screen.queryByTestId('screen-share-chat')).toBeNull();
    expect(localStorage.getItem('cojam.screenChat')).toBe('0');
    // The small view in the room column never carries the chat: the room has its own.
    fireEvent.click(screen.getByRole('button', { name: 'Reduzir' }));
    expect(screen.queryByRole('button', { name: 'Chat' })).toBeNull();
  });

  it('hides the controls after a while without the mouse, never the notice', () => {
    vi.useFakeTimers();
    try {
      seed({ screen: live() });
      renderWatching(watchingShare());
      const view = () => screen.getByTestId('screen-share-watching');
      expect(view().className).not.toContain('screen-share--idle');
      act(() => vi.advanceTimersByTime(IDLE_MS + 10));
      expect(view().className).toContain('screen-share--idle');
      expect(screen.getByTestId('screen-share-notice')).toBeTruthy();
      fireEvent.pointerMove(view());
      expect(view().className).not.toContain('screen-share--idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers the quality before sharing and remembers it', () => {
    seed();
    renderPanel(true);
    fireEvent.click(screen.getByRole('button', { name: 'Compartilhar tela' }));
    const select = screen.getByRole('combobox', { name: 'Qualidade da transmissão' }) as HTMLSelectElement;
    expect(select.value).toBe('text');
    expect(screen.getByTestId('screen-share-upload').textContent).toContain('1,2 Mbps');
    fireEvent.change(select, { target: { value: 'max' } });
    expect(select.value).toBe('max');
    expect(screen.getByTestId('screen-share-upload').textContent).toContain('4 Mbps');
    expect(localStorage.getItem('cojam.screenQuality')).toBe('max');
  });
});
