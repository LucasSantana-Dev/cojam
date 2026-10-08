import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useEffect, useRef } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { RoomState, TrackRef } from '@cojam/shared';
import type { IPlayer } from '@/lib/playerInterface';
import { RoomClient } from './client';
import { useStore } from '@/lib/realtime';
import { setListeningService } from '@/lib/listeningService';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const h = vi.hoisted(() => ({
  spotify: null as null | { onPlayerReady?: (p: unknown) => void; active?: boolean },
  youtube: null as null | { onPlayerReady?: (p: unknown) => void },
  drift: [] as unknown[],
  updatePlatform: vi.fn(),
}));

vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  joinRoom: vi.fn(async () => ({})),
  updatePlatform: h.updatePlatform,
}));
vi.mock('@/lib/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/account')>()),
  getAccountSession: vi.fn(async () => null),
  getConnectedServices: vi.fn(async () => []),
  getDisplayName: vi.fn(async () => null),
  markServiceConnected: vi.fn(async () => {}),
}));
vi.mock('@/lib/useDriftCorrection', () => ({
  useDriftCorrection: (player: unknown) => {
    h.drift.push(player);
  },
}));

// The real players need the Spotify SDK and the YouTube IFrame API; the switch
// logic under test lives in the room, so stand in for them.
vi.mock('../components/SpotifyPlayer', () => ({
  SpotifyPlayer: (props: { onAuthorized: (v: boolean) => void; onPlayerReady?: (p: unknown) => void; active?: boolean }) => {
    h.spotify = props;
    const { onAuthorized } = props;
    useEffect(() => {
      onAuthorized(true);
    }, [onAuthorized]);
    return null;
  },
}));
vi.mock('../components/YouTubePlayer', () => ({
  YouTubePlayer: (props: { onPlayerGone?: () => void; onPlayerReady?: (p: unknown) => void }) => {
    h.youtube = props;
    // Like the real player: keep the latest callback in a ref, call it on unmount only.
    const gone = useRef(props.onPlayerGone);
    useEffect(() => {
      gone.current = props.onPlayerGone;
    });
    useEffect(() => () => gone.current?.(), []);
    return null;
  },
}));

const track: TrackRef = {
  id: 't1',
  title: 'Both',
  artist: 'Band',
  sources: { spotify: { trackUri: 'spotify:track:1', confidence: 1 }, youtube: { videoId: 'v1', confidence: 1 } },
  addedBy: 'Ana',
};
const state: RoomState = { roomId: 'NEON42', queue: [track], nowPlayingId: 't1', radioEnabled: false, version: 1 };

const fakePlayer = (name: string) =>
  ({
    name,
    setVolume: vi.fn(),
    play: async () => {},
    pause: async () => {},
    seekToMs: async () => {},
    getCurrentPositionMs: async () => 0,
    getDurationMs: async () => 0,
    canSeek: () => true,
    onEnded: () => {},
    onPositionChanged: () => {},
  }) as unknown as IPlayer;
const lastDrift = () => h.drift[h.drift.length - 1];

describe('RoomClient switching "Ouvir no" between live players', () => {
  beforeEach(() => {
    h.spotify = null;
    h.youtube = null;
    h.drift = [];
    h.updatePlatform.mockClear();
    window.localStorage.clear();
    setListeningService('auto');
    sessionStorage.clear();
    window.__COJAM_ENV__ = { features: { spotify: true, youtube: true, sync: true } };
    useStore.setState({ state, signedIn: false, name: '' });
  });
  afterEach(() => {
    delete window.__COJAM_ENV__;
  });

  async function join() {
    render(<RoomClient roomId="NEON42" />);
    fireEvent.change(screen.getByLabelText('Seu nome'), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar na sala' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Entrar na sala' })).toBeNull());
  }

  it('hands drift correction to the chosen service and back, never leaving the old player active', async () => {
    await join();
    const spotify = fakePlayer('spotify');
    const youtube = fakePlayer('youtube');

    // auto + connected Spotify plays Spotify
    await waitFor(() => expect(h.spotify?.active).toBe(true));
    act(() => h.spotify!.onPlayerReady!(spotify));
    expect(lastDrift()).toBe(spotify);

    // YouTube chosen: the Spotify adapter stops driving, the Spotify SDK is told it is inactive
    act(() => setListeningService('youtube'));
    await waitFor(() => expect(h.youtube).not.toBeNull());
    expect(h.spotify?.active).toBe(false);
    expect(lastDrift()).toBeNull();
    act(() => h.youtube!.onPlayerReady!(youtube));
    expect(lastDrift()).toBe(youtube);

    // back to Spotify: its adapter is still alive, so it becomes active again
    act(() => setListeningService('spotify'));
    await waitFor(() => expect(h.spotify?.active).toBe(true));
    expect(lastDrift()).toBe(spotify);
  });

  it('a Spotify player that announces itself while another service was active does not hijack it, but recovers on switch', async () => {
    await join();
    act(() => setListeningService('youtube'));
    await waitFor(() => expect(h.youtube).not.toBeNull());
    const youtube = fakePlayer('youtube');
    act(() => h.youtube!.onPlayerReady!(youtube));
    const spotify = fakePlayer('spotify');
    act(() => h.spotify!.onPlayerReady!(spotify));
    expect(lastDrift()).toBe(youtube);
    act(() => setListeningService('spotify'));
    await waitFor(() => expect(lastDrift()).toBe(spotify));
  });

  it('switching to a service whose player has not announced itself leaves no active player', async () => {
    await join();
    const youtube = fakePlayer('youtube');
    act(() => setListeningService('youtube'));
    await waitFor(() => expect(h.youtube).not.toBeNull());
    act(() => h.youtube!.onPlayerReady!(youtube));
    expect(lastDrift()).toBe(youtube);
    act(() => setListeningService('spotify'));
    // YouTube unmounts (clearing it) and the Spotify adapter never announced: nothing drives.
    await waitFor(() => expect(lastDrift()).toBeNull());
  });

  it('tells the room the platform only after joining', async () => {
    render(<RoomClient roomId="NEON42" />);
    expect(h.updatePlatform).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Seu nome'), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar na sala' }));
    await waitFor(() => expect(h.updatePlatform).toHaveBeenCalledWith('NEON42', 'spotify'));
  });
});
