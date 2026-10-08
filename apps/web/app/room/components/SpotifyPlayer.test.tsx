import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { render, waitFor, screen, act } from '@testing-library/react';
import { SpotifyPlayer } from './SpotifyPlayer';
import { useStore } from '@/lib/realtime';
import { checkAccount } from '@/lib/spotifyAccount';
import type { RoomState, TrackRef } from '@cojam/shared';

// Auth/account modules touch localStorage and the Spotify accounts service;
// the adapter under test is the playback path, so stub both.
vi.mock('@/lib/spotifyAuth', () => ({
  beginAuth: vi.fn(),
  getAccessToken: vi.fn(async () => 'token'),
  isAuthed: vi.fn(() => true),
  needsSpotifyReconnect: vi.fn(() => false),
}));
vi.mock('@/lib/spotifyAccount', () => ({
  checkAccount: vi.fn(async () => 'premium'),
}));

const sdkPause = vi.fn(async () => {});

class FakeSpotifySDKPlayer {
  pause = sdkPause;
  addListener(event: string, cb: (data: { device_id: string }) => void) {
    if (event === 'ready') queueMicrotask(() => cb({ device_id: 'dev1' }));
    return true;
  }
  async connect() {
    return true;
  }
  async getCurrentState() {
    return null;
  }
}

const track: TrackRef = {
  id: 't1',
  title: 'Region Locked',
  artist: 'Some Artist',
  durationMs: 180_000,
  sources: { spotify: { trackUri: 'spotify:track:x', confidence: 1 } },
  addedBy: 'Ana',
};

const roomState: RoomState = {
  roomId: 'r1',
  queue: [track],
  nowPlayingId: 't1',
  radioEnabled: false,
  version: 1,
};

function renderPlayer(onPlayError: (trackId: string | null) => void) {
  return render(
    <SpotifyPlayer authorized={true} onAuthorized={() => {}} onPlayError={onPlayError} />,
  );
}

describe('SpotifyPlayer play failure surface', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    (window as { Spotify?: unknown }).Spotify = { Player: FakeSpotifySDKPlayer };
    window.__COJAM_ENV__ = { spotifyClientId: 'test-client' };
    useStore.setState({ state: roomState });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as { Spotify?: unknown }).Spotify;
    delete window.__COJAM_ENV__;
    useStore.setState({ state: undefined });
  });

  it('reports the now-playing track when the play request is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403 }) as Response),
    );
    const onPlayError = vi.fn();
    renderPlayer(onPlayError);
    await waitFor(() => expect(onPlayError).toHaveBeenCalledWith('t1'));
  });

  it('reports the now-playing track when the play request 404s (no active device)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }) as Response),
    );
    const onPlayError = vi.fn();
    renderPlayer(onPlayError);
    await waitFor(() => expect(onPlayError).toHaveBeenCalledWith('t1'));
  });

  it('clears the failure state when playback starts successfully', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 204 }) as Response),
    );
    const onPlayError = vi.fn();
    renderPlayer(onPlayError);
    await waitFor(() => expect(onPlayError).toHaveBeenCalledWith(null));
    expect(onPlayError).not.toHaveBeenCalledWith('t1');
  });
});

describe('SpotifyPlayer connect failure surface', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    (window as { Spotify?: unknown }).Spotify = { Player: FakeSpotifySDKPlayer };
    window.__COJAM_ENV__ = { spotifyClientId: 'test-client' };
    useStore.setState({ state: roomState });
  });

  afterEach(() => {
    vi.mocked(checkAccount).mockResolvedValue('premium');
    vi.restoreAllMocks();
    delete (window as { Spotify?: unknown }).Spotify;
    delete window.__COJAM_ENV__;
    useStore.setState({ state: undefined });
  });

  function Harness() {
    const [authorized, setAuthorized] = useState(true);
    return <SpotifyPlayer authorized={authorized} onAuthorized={setAuthorized} />;
  }

  it('tells a free account the player needs Premium and keeps the connect button out of the way', async () => {
    vi.mocked(checkAccount).mockResolvedValue('free');
    render(<Harness />);
    const alert = await screen.findByTestId('spotify-connect-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('precisa de uma conta Premium');
    expect(alert).toHaveTextContent('YouTube');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('points at the tester list when /v1/me answers 403', async () => {
    vi.mocked(checkAccount).mockResolvedValue('forbidden');
    render(<Harness />);
    expect(await screen.findByTestId('spotify-connect-error')).toHaveTextContent('lista de testadores');
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument();
  });

  it('asks to reconnect when no access token can be had', async () => {
    const auth = await import('@/lib/spotifyAuth');
    vi.mocked(auth.getAccessToken).mockResolvedValueOnce(null as unknown as string);
    vi.mocked(auth.needsSpotifyReconnect).mockReturnValueOnce(true);
    render(<Harness />);
    expect(await screen.findByTestId('spotify-connect-error')).toHaveTextContent('Conecte de novo');
  });

  it('shows no error before anything failed', () => {
    render(<SpotifyPlayer authorized={false} onAuthorized={() => {}} />);
    expect(screen.queryByTestId('spotify-connect-error')).toBeNull();
    expect(screen.getByRole('button', { name: 'Conectar Spotify' })).toBeInTheDocument();
  });
});

describe('SpotifyPlayer end of track', () => {
  let stateCb: ((s: unknown) => void) | null = null;
  const pauseSpy = vi.fn(async () => {});
  class StatefulSDKPlayer extends FakeSpotifySDKPlayer {
    pause = pauseSpy;
    addListener(event: string, cb: (data: never) => void) {
      if (event === 'player_state_changed') stateCb = cb as (s: unknown) => void;
      return super.addListener(event, cb as (d: { device_id: string }) => void);
    }
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 204 }) as Response));
    (window as { Spotify?: unknown }).Spotify = { Player: StatefulSDKPlayer };
    window.__COJAM_ENV__ = { spotifyClientId: 'test-client' };
    useStore.setState({ state: roomState });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as { Spotify?: unknown }).Spotify;
    delete window.__COJAM_ENV__;
    useStore.setState({ state: undefined });
    stateCb = null;
  });

  it('fires onEnded when the SDK reports the track finished, with no position subscriber', async () => {
    let player: import('@/lib/playerInterface').IPlayer | null = null;
    render(
      <SpotifyPlayer authorized={true} onAuthorized={() => {}} onPlayerReady={(p) => (player = p)} />,
    );
    await waitFor(() => expect(player).not.toBeNull());
    const ended = vi.fn();
    player!.onEnded(ended);
    const win = (paused: boolean, position: number, prev: string[]) => ({
      paused,
      position,
      track_window: {
        current_track: { id: 'x', uri: 'spotify:track:x' },
        previous_tracks: prev.map((id) => ({ id, uri: `spotify:track:${id}` })),
      },
    });
    stateCb!(win(false, 120_000, []));
    expect(ended).not.toHaveBeenCalled();
    stateCb!(win(true, 0, ['x']));
    expect(ended).toHaveBeenCalledTimes(1);
    stateCb!(win(true, 0, ['x']));
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('Spotify Autoplay: pauses the foreign track, advances once, and the poll cannot double-fire', async () => {
    let player: import('@/lib/playerInterface').IPlayer | null = null;
    render(
      <SpotifyPlayer authorized={true} onAuthorized={() => {}} onPlayerReady={(p) => (player = p)} />,
    );
    await waitFor(() => expect(player).not.toBeNull());
    await waitFor(() => expect(fetch).toHaveBeenCalled()); // playUri ran, expected track set
    const ended = vi.fn();
    player!.onEnded(ended);
    const x = { id: 'x', uri: 'spotify:track:x' };
    stateCb!({ paused: false, position: 170_000, track_window: { current_track: x, previous_tracks: [] } });
    stateCb!({
      paused: false,
      position: 200,
      track_window: { current_track: { id: 'rec', uri: 'spotify:track:rec' }, previous_tracks: [x] },
    });
    expect(ended).toHaveBeenCalledTimes(1);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });
});


describe('SpotifyPlayer switching service', () => {
  const calls = (fetchMock: ReturnType<typeof vi.fn>, part: string) =>
    fetchMock.mock.calls.filter((c) => String(c[0]).includes(part));

  beforeEach(() => {
    sdkPause.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    (window as { Spotify?: unknown }).Spotify = { Player: FakeSpotifySDKPlayer };
    window.__COJAM_ENV__ = { spotifyClientId: 'test-client' };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as { Spotify?: unknown }).Spotify;
    delete window.__COJAM_ENV__;
    useStore.setState({ state: undefined });
  });

  it('a paused room stays silent when switching to Spotify, then plays once the room plays', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    useStore.setState({ state: { ...roomState, transport: { state: 'paused', positionMs: 5000, updatedAtServerMs: 1 } } as RoomState });
    render(<SpotifyPlayer authorized={true} onAuthorized={() => {}} active={true} />);
    await screen.findByText(/Spotify conectado/);
    await waitFor(() => expect(screen.getByText(/Spotify conectado$/)).toBeTruthy());
    expect(calls(fetchMock, '/me/player/play')).toHaveLength(0);
    act(() => {
      useStore.setState({ state: { ...roomState, version: 2, transport: { state: 'playing', positionMs: 5000, updatedAtServerMs: 2 } } as RoomState });
    });
    await waitFor(() => expect(calls(fetchMock, '/me/player/play')).toHaveLength(1));
  });

  it('switching away pauses this SDK device only, not the account through the Web API', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    useStore.setState({ state: { ...roomState, transport: { state: 'playing', positionMs: 0, updatedAtServerMs: 1 } } as RoomState });
    const { rerender } = render(<SpotifyPlayer authorized={true} onAuthorized={() => {}} active={true} />);
    await waitFor(() => expect(calls(fetchMock, '/me/player/play')).toHaveLength(1));
    rerender(<SpotifyPlayer authorized={true} onAuthorized={() => {}} active={false} />);
    await waitFor(() => expect(sdkPause).toHaveBeenCalled());
    expect(calls(fetchMock, '/me/player/pause')).toHaveLength(0);
  });
});
