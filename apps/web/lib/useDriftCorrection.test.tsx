import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDriftCorrection } from './useDriftCorrection';
import { useStore } from './realtime';
import type { RoomState, TransportState } from '@cojam/shared';

const advanceMock = vi.hoisted(() => vi.fn<(roomId: string, afterId: string) => Promise<void>>(async () => {}));
vi.mock('./realtime', async (importActual) => ({
  ...(await importActual<typeof import('./realtime')>()),
  nowPlayingAdvance: advanceMock,
}));

// The hook drives the real zustand store (seeded per case); only the player
// adapter is mocked, so a room.state publication flows exactly like the live
// room channel.
const makePlayer = () => ({
  play: vi.fn(async () => {}),
  pause: vi.fn(async () => {}),
  seekToMs: vi.fn(async () => {}),
  getCurrentPositionMs: vi.fn(async () => 0),
  getDurationMs: vi.fn(async () => 180_000),
  canSeek: vi.fn(() => true),
  onEnded: vi.fn(() => {}),
  onPositionChanged: vi.fn(() => {}),
});

const PLAYING: TransportState = { state: 'playing', positionMs: 1000, updatedAtServerMs: 1_000_000 };

const roomState = (version: number, transport: TransportState, votes?: RoomState['votes']): RoomState => ({
  roomId: 'r1',
  queue: [],
  radioEnabled: false,
  version,
  transport,
  votes,
});

describe('useDriftCorrection (#177)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStore.setState({ state: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not re-invoke play/seek on a votes-only publication', () => {
    const player = makePlayer();
    useStore.getState().setState(roomState(1, PLAYING));
    const { unmount } = renderHook(() => useDriftCorrection(player, true));

    // Initial transport application: one play + one sync seek.
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.seekToMs).toHaveBeenCalledTimes(1);
    player.play.mockClear();
    player.seekToMs.mockClear();

    // A publication that only touches votes carries a FRESH transport object
    // with unchanged fields: zero player calls, no interval churn.
    act(() => {
      useStore.getState().setState(roomState(2, { ...PLAYING }, { t1: ['user:a'] }));
    });

    expect(player.play).not.toHaveBeenCalled();
    expect(player.seekToMs).not.toHaveBeenCalled();
    unmount();
  });

  it('re-applies the transport when a meaningful field changes', () => {
    const player = makePlayer();
    useStore.getState().setState(roomState(1, PLAYING));
    const { unmount } = renderHook(() => useDriftCorrection(player, true));
    player.play.mockClear();
    player.seekToMs.mockClear();

    act(() => {
      useStore.getState().setState(
        roomState(2, { state: 'playing', positionMs: 5000, updatedAtServerMs: 1_000_100 }),
      );
    });

    expect(player.play).toHaveBeenCalledTimes(1);
    expect(player.seekToMs).toHaveBeenCalledTimes(1);
    expect(player.seekToMs).toHaveBeenCalledWith(expect.any(Number));
    unmount();
  });

  it('pauses instead of playing on a playing -> paused transition', () => {
    const player = makePlayer();
    useStore.getState().setState(roomState(1, PLAYING));
    const { unmount } = renderHook(() => useDriftCorrection(player, true));
    player.play.mockClear();
    player.pause.mockClear();

    act(() => {
      useStore.getState().setState(
        roomState(2, { state: 'paused', positionMs: 1000, updatedAtServerMs: 1_000_100 }),
      );
    });

    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(player.play).not.toHaveBeenCalled();
    unmount();
  });

  it('does nothing while the sync flag is off', () => {
    const player = makePlayer();
    useStore.getState().setState(roomState(1, PLAYING));
    const { unmount } = renderHook(() => useDriftCorrection(player, false));

    expect(player.play).not.toHaveBeenCalled();
    expect(player.seekToMs).not.toHaveBeenCalled();
    unmount();
  });
  describe('YouTube 2 s loop (clock behind server, buffering reads)', () => {
    it('never seeks to a clamped 0 when the client clock is behind the server', async () => {
      const player = makePlayer();
      player.getCurrentPositionMs.mockResolvedValue(30_000);
      // Server stamped the play 60 s "in the future" of this client's clock.
      const t: TransportState = { state: 'playing', positionMs: 0, updatedAtServerMs: Date.now() + 60_000 };
      useStore.getState().setState(roomState(1, t));
      const { unmount } = renderHook(() => useDriftCorrection(player, true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(player.seekToMs).not.toHaveBeenCalled();
      unmount();
    });

    it('skips drift checks while the player is not PLAYING', async () => {
      const player = { ...makePlayer(), isPlaying: vi.fn(() => false) };
      player.getCurrentPositionMs.mockResolvedValue(0);
      useStore.getState().setState(
        roomState(1, { state: 'playing', positionMs: 0, updatedAtServerMs: Date.now() - 20_000 }),
      );
      const { unmount } = renderHook(() => useDriftCorrection(player, true));
      player.seekToMs.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(player.seekToMs).not.toHaveBeenCalled();
      unmount();
    });

    it('waits out a cooldown after a seek before correcting again', async () => {
      const player = makePlayer();
      // Position read stays stale at 0 (seek not settled): old code re-seeked every 1.5 s.
      player.getCurrentPositionMs.mockResolvedValue(0);
      useStore.getState().setState(
        roomState(1, { state: 'playing', positionMs: 0, updatedAtServerMs: Date.now() - 20_000 }),
      );
      const { unmount } = renderHook(() => useDriftCorrection(player, true));
      expect(player.seekToMs).toHaveBeenCalledTimes(1); // initial sync seek
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000); // tick at 1.5 s, inside the cooldown
      });
      expect(player.seekToMs).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500); // tick at 4.5 s, cooldown over
      });
      expect(player.seekToMs).toHaveBeenCalledTimes(2);
      unmount();
    });

    it('corrects once the offset lands when the position was unknown at start', async () => {
      const player = makePlayer();
      player.getCurrentPositionMs.mockResolvedValue(0);
      const t: TransportState = { state: 'playing', positionMs: 0, updatedAtServerMs: Date.now() + 60_000 };
      useStore.getState().setState(roomState(1, t));
      const { unmount } = renderHook(() => useDriftCorrection(player, true));
      expect(player.seekToMs).not.toHaveBeenCalled(); // initial seek skipped
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(player.seekToMs).not.toHaveBeenCalled();
      // Offset lands: server stamp is now 20 s in the past of our corrected clock.
      act(() => {
        useStore.getState().setState(
          roomState(2, { state: 'playing', positionMs: 0, updatedAtServerMs: Date.now() - 20_000 }),
        );
      });
      // New transport fields re-run the effect (initial seek), position is stale at 0.
      expect(player.seekToMs).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('keeps the interval alive while unknown, correcting when the clock fixes itself', async () => {
      const player = makePlayer();
      player.getCurrentPositionMs.mockResolvedValue(0);
      const stamp = Date.now() + 5000; // 5 s ahead: unknown now, known after 3+ s
      useStore.getState().setState(roomState(1, { state: 'playing', positionMs: 0, updatedAtServerMs: stamp }));
      const { unmount } = renderHook(() => useDriftCorrection(player, true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000); // elapsed reaches ~4 s, drift > 1 s
      });
      expect(player.seekToMs).toHaveBeenCalled();
      unmount();
    });

    it('tries play() once when the player is paused while the room plays', async () => {
      const player = { ...makePlayer(), isPlaying: vi.fn(() => false), isPaused: vi.fn(() => true) };
      useStore.getState().setState(
        roomState(1, { state: 'playing', positionMs: 0, updatedAtServerMs: Date.now() - 5000 }),
      );
      const { unmount } = renderHook(() => useDriftCorrection(player, true));
      player.play.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(player.play).toHaveBeenCalledTimes(1);
      unmount();
    });
  });
});

describe('useDriftCorrection past the end of the track', () => {
  const NOW = 1_700_000_000_000;
  // The prod shape: playing at 0, stamped an hour ago, a 3:43 track.
  const STALE: TransportState = { state: 'playing', positionMs: 0, updatedAtServerMs: NOW - 62 * 60 * 1000 };
  const seed = (version: number, transport: TransportState, durationMs: number | undefined = 223_000) =>
    useStore.getState().setState({
      ...roomState(version, transport),
      queue: [{ id: 't1', title: 'One', artist: 'A', durationMs, sources: {}, addedBy: 'x' }],
      nowPlayingId: 't1',
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    advanceMock.mockClear();
    useStore.setState({ state: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never seeks past the end and advances once when the user can control', () => {
    const player = makePlayer();
    seed(1, STALE);
    const { unmount } = renderHook(() => useDriftCorrection(player, true, true));
    act(() => {
      vi.advanceTimersByTime(10_000); // several drift ticks
    });
    expect(player.seekToMs).not.toHaveBeenCalled();
    expect(advanceMock).toHaveBeenCalledTimes(1);
    expect(advanceMock).toHaveBeenCalledWith('r1', 't1');
    unmount();
  });

  it('does not double-advance on a re-publication of the same stale transport', () => {
    const player = makePlayer();
    seed(1, STALE);
    const { unmount } = renderHook(() => useDriftCorrection(player, true, true));
    act(() => {
      seed(2, { ...STALE, positionMs: 1 });
    });
    expect(advanceMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('a listener stops correcting and waits, without advancing', () => {
    const player = makePlayer();
    seed(1, STALE);
    const { unmount } = renderHook(() => useDriftCorrection(player, true, false));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(player.seekToMs).not.toHaveBeenCalled();
    expect(advanceMock).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps syncing a live track and a track with unknown duration', () => {
    const live = makePlayer();
    seed(1, { state: 'playing', positionMs: 0, updatedAtServerMs: NOW - 30_000 });
    const a = renderHook(() => useDriftCorrection(live, true, true));
    expect(live.seekToMs).toHaveBeenCalledTimes(1);
    a.unmount();

    const unknown = makePlayer();
    seed(2, STALE, 0);
    const b = renderHook(() => useDriftCorrection(unknown, true, true));
    expect(unknown.seekToMs).toHaveBeenCalledTimes(1);
    expect(advanceMock).not.toHaveBeenCalled();
    b.unmount();
  });
});
