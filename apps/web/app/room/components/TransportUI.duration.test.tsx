import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { TransportUI } from './TransportUI';
import { useStore } from '@/lib/realtime';
import type { IPlayer } from '@/lib/playerInterface';

describe('TransportUI stale duration on track change', () => {
  it('ignores the previous video length until the player is PLAYING', async () => {
    const mkState = (id: string) => ({
      roomId: 'r1',
      queue: [
        { id: 'a', title: 'A', artist: 'A', sources: {}, addedBy: 'Ana' },
        { id: 'b', title: 'B', artist: 'B', sources: {}, addedBy: 'Ana' },
      ],
      nowPlayingId: id,
      radioEnabled: false,
      version: 1,
      transport: { state: 'paused' as const, positionMs: 0, updatedAtServerMs: 0 },
    });
    useStore.setState({ state: mkState('a') });
    let playing = true;
    let duration = 50000;
    const player: IPlayer = {
      play: vi.fn(async () => {}),
      pause: vi.fn(async () => {}),
      seekToMs: vi.fn(async () => {}),
      getCurrentPositionMs: vi.fn(async () => 0),
      getDurationMs: vi.fn(async () => duration),
      isPlaying: () => playing,
      canSeek: () => true,
      onEnded: vi.fn(),
      onPositionChanged: vi.fn(),
    };
    render(<TransportUI roomId="r1" activePlayer={player} canControl />);
    const slider = () => screen.getByLabelText('Posição da faixa');
    await waitFor(() => expect(slider()).toHaveAttribute('max', '50000'));

    // Track change: the player still reports the old length and is not PLAYING yet.
    playing = false;
    act(() => useStore.setState({ state: mkState('b') }));
    expect(slider()).toHaveAttribute('max', '0');
    await new Promise((r) => setTimeout(r, 1200));
    expect(slider()).toHaveAttribute('max', '0');

    // Now PLAYING with the new video's real length.
    playing = true;
    duration = 19000;
    await waitFor(() => expect(slider()).toHaveAttribute('max', '19000'), { timeout: 3000 });
  });
});
