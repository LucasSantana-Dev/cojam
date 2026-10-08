import { describe, it, expect, vi } from 'vitest';
import { visualSyncStep, VISUAL_DRIFT_MS } from './useVisualSync';
import type { IPlayer } from './playerInterface';

function fakePlayer(playing: boolean, posMs: number) {
  return {
    play: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    seekToMs: vi.fn(async () => {}),
    getCurrentPositionMs: vi.fn(async () => posMs),
    getDurationMs: async () => 200000,
    canSeek: () => true,
    isPlaying: () => playing,
    onEnded: vi.fn(),
    onPositionChanged: vi.fn(),
  } satisfies IPlayer;
}

const NOW = 1_000_000;
const playingAt = (positionMs: number) => ({ state: 'playing' as const, positionMs, updatedAtServerMs: NOW });

describe('visualSyncStep (muted palco video for Spotify listeners)', () => {
  it('starts the video when the room plays and pauses it when the room pauses', async () => {
    const stopped = fakePlayer(false, 0);
    expect(await visualSyncStep(stopped, playingAt(1000), NOW)).toBe('play');
    expect(stopped.play).toHaveBeenCalled();
    const running = fakePlayer(true, 5000);
    expect(await visualSyncStep(running, { state: 'paused', positionMs: 5000, updatedAtServerMs: NOW }, NOW)).toBe('pause');
    expect(running.pause).toHaveBeenCalled();
  });

  it('tolerates a relaxed drift and seeks only past it', async () => {
    const near = fakePlayer(true, 60000 + VISUAL_DRIFT_MS - 100);
    expect(await visualSyncStep(near, playingAt(60000), NOW)).toBeNull();
    expect(near.seekToMs).not.toHaveBeenCalled();
    const far = fakePlayer(true, 60000 + VISUAL_DRIFT_MS + 500);
    expect(await visualSyncStep(far, playingAt(60000), NOW)).toBe('seek');
    expect(far.seekToMs).toHaveBeenCalledWith(60000);
  });

  it('does nothing without a transport or with a paused video in a paused room', async () => {
    const p = fakePlayer(false, 0);
    expect(await visualSyncStep(p, undefined, NOW)).toBeNull();
    expect(await visualSyncStep(p, { state: 'paused', positionMs: 0, updatedAtServerMs: NOW }, NOW)).toBeNull();
    expect(p.play).not.toHaveBeenCalled();
    expect(p.pause).not.toHaveBeenCalled();
  });
});
