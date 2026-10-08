import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { YouTubePlayer } from './YouTubePlayer';
import { useStore } from '@/lib/realtime';
import type { RoomState } from '@cojam/shared';

type Events = { onReady?: () => void };
let events: Events | null = null;

const roomState: RoomState = {
  roomId: 'r1',
  queue: [{ id: 't1', title: 'T', artist: 'A', durationMs: 1000, sources: { youtube: { videoId: 'v1', confidence: 1 } }, addedBy: 'Ana' }],
  nowPlayingId: 't1',
  radioEnabled: false,
  version: 1,
};

function mount(playerState: number | undefined) {
  class FakeYT {
    getPlayerState = playerState === undefined ? undefined : () => playerState;
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
    constructor(_id: string, opts: { events?: Events }) {
      events = opts.events ?? null;
    }
  }
  (window as { YT?: unknown }).YT = { Player: FakeYT };
  useStore.setState({ state: roomState });
  const onPlayerReady = vi.fn();
  render(<YouTubePlayer roomId="r1" onPlayerReady={onPlayerReady} />);
  act(() => events!.onReady!());
  return onPlayerReady.mock.calls[0][0] as { isPlaying(): boolean };
}

describe('YouTubePlayer isPlaying', () => {
  afterEach(() => {
    delete (window as { YT?: unknown }).YT;
    useStore.setState({ state: undefined });
  });

  it('is false when getPlayerState is missing', () => {
    expect(mount(undefined).isPlaying()).toBe(false);
  });

  it('is true only in the PLAYING state', () => {
    expect(mount(1).isPlaying()).toBe(true);
    expect(mount(2).isPlaying()).toBe(false);
  });
});
