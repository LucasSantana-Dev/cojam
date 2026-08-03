import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { SpotifyPlayer } from './SpotifyPlayer';
import { useStore } from '@/lib/realtime';
import type { RoomState, TrackRef } from '@cojam/shared';

// Auth/account modules touch localStorage and the Spotify accounts service;
// the adapter under test is the playback path, so stub both.
vi.mock('@/lib/spotifyAuth', () => ({
  beginAuth: vi.fn(),
  getAccessToken: vi.fn(async () => 'token'),
  isAuthed: vi.fn(() => true),
}));
vi.mock('@/lib/spotifyAccount', () => ({
  decidePlayable: vi.fn(async () => true),
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
