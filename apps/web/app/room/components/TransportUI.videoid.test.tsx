import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { TransportUI } from './TransportUI';
import { useStore } from '@/lib/realtime';
import type { IPlayer } from '@/lib/playerInterface';

const yt = (id: string) => ({ youtube: { videoId: id, confidence: 1 } });

function setup(queue: Array<Record<string, unknown>>, nowId: string) {
  const mk = (id: string) =>
    ({
      roomId: 'r1',
      queue,
      nowPlayingId: id,
      radioEnabled: false,
      version: 1,
      transport: { state: 'playing' as const, positionMs: 0, updatedAtServerMs: 0 },
    }) as never;
  useStore.setState({ state: mk(nowId) });
  const live = { loaded: 'vidA', duration: 50000 };
  const player: IPlayer = {
    play: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    seekToMs: vi.fn(async () => {}),
    getCurrentPositionMs: vi.fn(async () => 0),
    getDurationMs: vi.fn(async () => live.duration),
    // Cached PLAYING state from the previous video: always true.
    isPlaying: () => true,
    getLoadedVideoId: () => live.loaded,
    canSeek: () => true,
    onEnded: vi.fn(),
    onPositionChanged: vi.fn(),
  };
  render(<TransportUI roomId="r1" activePlayer={player} canControl />);
  return { live, switchTo: (id: string) => act(() => useStore.setState({ state: mk(id) })) };
}

const slider = () => screen.getByLabelText('Posição da faixa');

describe('TransportUI duration is bound to the loaded video id', () => {
  it('hole 1: metadata track then a hand-added link does not inherit the previous length', async () => {
    const { live, switchTo } = setup(
      [
        { id: 'a', title: 'A', artist: 'A', durationMs: 50000, sources: yt('vidA'), addedBy: 'Ana' },
        { id: 'b', title: 'B', artist: 'B', sources: yt('vidB'), addedBy: 'Ana' },
      ],
      'a',
    );
    expect(slider()).toHaveAttribute('max', '50000');
    switchTo('b');
    await new Promise((r) => setTimeout(r, 1200));
    expect(slider()).toHaveAttribute('max', '0');
    live.loaded = 'vidB';
    live.duration = 19000;
    await waitFor(() => expect(slider()).toHaveAttribute('max', '19000'), { timeout: 3000 });
  });

  it('hole 2: a mid-song skip ignores the cached PLAYING state and old length', async () => {
    const { live, switchTo } = setup(
      [
        { id: 'a', title: 'A', artist: 'A', sources: yt('vidA'), addedBy: 'Ana' },
        { id: 'b', title: 'B', artist: 'B', sources: yt('vidB'), addedBy: 'Ana' },
      ],
      'a',
    );
    await waitFor(() => expect(slider()).toHaveAttribute('max', '50000'));
    switchTo('b');
    await new Promise((r) => setTimeout(r, 1200));
    expect(slider()).toHaveAttribute('max', '0');
    live.loaded = 'vidB';
    live.duration = 19000;
    await waitFor(() => expect(slider()).toHaveAttribute('max', '19000'), { timeout: 3000 });
  });
});
