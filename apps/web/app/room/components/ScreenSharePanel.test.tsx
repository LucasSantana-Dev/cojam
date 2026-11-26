import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { RoomState, ScreenShareState } from '@cojam/shared';
import { ScreenSharePanel } from './ScreenSharePanel';
import { useStore } from '@/lib/realtime';

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

  it('watching shows the notice that cannot be closed, and "Parar de assistir" unwatches', async () => {
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

  it('drops the video when the share disappears from the room state', async () => {
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
});
