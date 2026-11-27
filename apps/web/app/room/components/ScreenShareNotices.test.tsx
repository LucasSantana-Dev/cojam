import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { RoomState, ScreenShareState } from '@cojam/shared';
import { ScreenSharePanel } from './ScreenSharePanel';
import { useStore } from '@/lib/realtime';
import { affirmAge } from '@/lib/ageGate';
import { markShared } from '@/lib/screenShareNotices';

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

describe('screen share notices (spec 5.7)', () => {
  it('says the broadcaster left the room when the share ends that way', async () => {
    affirmAge();
    useStore.setState({
      state: state({ screen: live() }),
      clientId: 'me',
      connected: true,
      connections: [{ clientId: 'b1', name: 'Ana' } as never],
    });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Assistir' }));
    await waitFor(() => expect(screen.getByTestId('screen-share-watching')).toBeTruthy());
    useStore.setState({ state: state(), connections: [] });
    await waitFor(() => expect(screen.getByText('A transmissão terminou.')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Ana saiu da sala e a transmissão terminou.')).toBeTruthy(), {
      timeout: 3000,
    });
  });

  it('keeps the plain end notice while the broadcaster is still in the room', async () => {
    affirmAge();
    useStore.setState({
      state: state({ screen: live() }),
      clientId: 'me',
      connected: true,
      connections: [{ clientId: 'b1', name: 'Ana' } as never],
    });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Assistir' }));
    await waitFor(() => expect(screen.getByTestId('screen-share-watching')).toBeTruthy());
    useStore.setState({ state: state() });
    await new Promise((r) => setTimeout(r, 1700));
    expect(screen.getByText('A transmissão terminou.')).toBeTruthy();
  });

  it('folds the audio tip to one line after the first share', () => {
    affirmAge();
    seed();
    const first = renderPanel(true);
    fireEvent.click(screen.getByRole('button', { name: 'Compartilhar tela' }));
    expect(screen.queryByTestId('screen-share-tip-short')).toBeNull();
    first.unmount();
    markShared();
    renderPanel(true);
    fireEvent.click(screen.getByRole('button', { name: 'Compartilhar tela' }));
    expect(screen.getByTestId('screen-share-tip-short').textContent).toContain('Como levar o som');
  });
});
