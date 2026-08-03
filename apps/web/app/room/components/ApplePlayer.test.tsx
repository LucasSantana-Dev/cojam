import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { ApplePlayer } from './ApplePlayer';
import { useStore } from '@/lib/realtime';
import type { RoomState, TrackRef } from '@cojam/shared';

type FakeMusic = {
  play: () => Promise<void>;
  pause: () => Promise<void>;
  seekToTime: (seconds: number) => Promise<void>;
  setQueue: (opts: { songs: string[] }) => Promise<unknown>;
  authorize: () => Promise<void>;
  isAuthorized: boolean;
  currentPlaybackTime: number;
  currentPlaybackDuration: number;
};

function makeMusic(overrides: Partial<FakeMusic>): FakeMusic {
  return {
    play: async () => {},
    pause: async () => {},
    seekToTime: async () => {},
    setQueue: async () => ({}),
    authorize: async () => {},
    isAuthorized: true,
    currentPlaybackTime: 0,
    currentPlaybackDuration: 0,
    ...overrides,
  };
}

const track: TrackRef = {
  id: 't1',
  title: 'Not In Catalog',
  artist: 'Some Artist',
  durationMs: 180_000,
  sources: { apple: { songId: 'song1', confidence: 1 } },
  addedBy: 'Ana',
};

const roomState = (withNowPlaying: boolean): RoomState => ({
  roomId: 'r1',
  queue: [track],
  nowPlayingId: withNowPlaying ? 't1' : undefined,
  radioEnabled: false,
  version: 1,
});

describe('ApplePlayer play failure surface', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ token: 'dev-token' }),
      }) as Response),
    );
    window.__COJAM_ENV__ = { features: { apple: true } };
    useStore.setState({ state: roomState(false) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as { MusicKit?: unknown }).MusicKit;
    delete window.__COJAM_ENV__;
    useStore.setState({ state: undefined });
  });

  async function renderReady(music: FakeMusic, onPlayError: (trackId: string | null) => void) {
    (window as { MusicKit?: unknown }).MusicKit = {
      configure: async () => {},
      getInstance: () => music,
    };
    render(<ApplePlayer authorized={true} onAuthorized={() => {}} onPlayError={onPlayError} />);
    // Wait for MusicKit init to flip the component to ready, then publish the
    // now-playing track so the play effect runs against a ready instance.
    await screen.findByText(/Apple Music connected/);
    act(() => useStore.setState({ state: roomState(true) }));
  }

  it('reports the now-playing track when setQueue rejects', async () => {
    const onPlayError = vi.fn();
    await renderReady(
      makeMusic({ setQueue: async () => Promise.reject(new Error('not available')) }),
      onPlayError,
    );
    await waitFor(() => expect(onPlayError).toHaveBeenCalledWith('t1'));
  });

  it('reports the now-playing track when play() rejects', async () => {
    const onPlayError = vi.fn();
    await renderReady(
      makeMusic({ play: async () => Promise.reject(new Error('playback failed')) }),
      onPlayError,
    );
    await waitFor(() => expect(onPlayError).toHaveBeenCalledWith('t1'));
  });

  it('clears the failure state when playback starts successfully', async () => {
    const onPlayError = vi.fn();
    await renderReady(makeMusic({}), onPlayError);
    await waitFor(() => expect(onPlayError).toHaveBeenCalledWith(null));
    expect(onPlayError).not.toHaveBeenCalledWith('t1');
  });
});
