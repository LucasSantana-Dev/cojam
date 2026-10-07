import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { render, waitFor, screen } from '@testing-library/react';
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

class FakeSpotifySDKPlayer {
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
