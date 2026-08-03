import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { YouTubePlayer, isUnplayableYtError } from './YouTubePlayer';
import { useStore } from '@/lib/realtime';
import type { RoomState, TrackRef } from '@cojam/shared';

// nowPlayingAdvance is the only RPC the component can fire (track end); the
// failure-path tests never reach it, but keep it off the network anyway.
vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  nowPlayingAdvance: vi.fn(async () => {}),
}));

type YTEvents = {
  onReady?: () => void;
  onStateChange?: (event: { data: number }) => void;
  onError?: (event: { data: number }) => void;
};

let capturedEvents: YTEvents | null = null;

class FakeYTPlayer {
  playVideo() {}
  pauseVideo() {}
  seekTo() {}
  getCurrentTime() {
    return 0;
  }
  getDuration() {
    return 0;
  }
  loadVideoById() {}
  constructor(_elementId: string, opts: { events?: YTEvents }) {
    capturedEvents = opts.events ?? null;
  }
}

const track: TrackRef = {
  id: 't1',
  title: 'Dead Video',
  artist: 'Some Artist',
  durationMs: 180_000,
  sources: { youtube: { videoId: 'vid1', confidence: 1 } },
  addedBy: 'Ana',
};

const roomState: RoomState = {
  roomId: 'r1',
  queue: [track],
  nowPlayingId: 't1',
  radioEnabled: false,
  version: 1,
};

describe('isUnplayableYtError', () => {
  it('maps removed/embed-restricted codes to unplayable', () => {
    expect(isUnplayableYtError(100)).toBe(true);
    expect(isUnplayableYtError(101)).toBe(true);
    expect(isUnplayableYtError(150)).toBe(true);
  });

  it('ignores transient player errors', () => {
    expect(isUnplayableYtError(2)).toBe(false);
    expect(isUnplayableYtError(5)).toBe(false);
  });
});

describe('YouTubePlayer onError wiring', () => {
  beforeEach(() => {
    capturedEvents = null;
    (window as { YT?: unknown }).YT = { Player: FakeYTPlayer };
    useStore.setState({ state: roomState });
  });

  afterEach(() => {
    delete (window as { YT?: unknown }).YT;
    useStore.setState({ state: undefined });
  });

  it.each([100, 101, 150])('reports the now-playing track on YT error %i', (code) => {
    const onPlayError = vi.fn();
    render(<YouTubePlayer roomId="r1" onPlayError={onPlayError} />);
    expect(capturedEvents?.onError).toBeDefined();
    act(() => capturedEvents!.onError!({ data: code }));
    expect(onPlayError).toHaveBeenCalledWith('t1');
  });

  it('ignores non-unplayable error codes', () => {
    const onPlayError = vi.fn();
    render(<YouTubePlayer roomId="r1" onPlayError={onPlayError} />);
    act(() => capturedEvents!.onError!({ data: 2 }));
    expect(onPlayError).not.toHaveBeenCalled();
  });

  it('clears the failure when playback actually starts', () => {
    const onPlayError = vi.fn();
    render(<YouTubePlayer roomId="r1" onPlayError={onPlayError} />);
    act(() => capturedEvents!.onError!({ data: 150 }));
    expect(onPlayError).toHaveBeenCalledWith('t1');
    act(() => capturedEvents!.onStateChange!({ data: 1 }));
    expect(onPlayError).toHaveBeenLastCalledWith(null);
  });
});
