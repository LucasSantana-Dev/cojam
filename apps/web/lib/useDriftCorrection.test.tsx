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
  nowPlayingId: 't0',
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

    // A chase: the player lags the expected position by 3 s after every seek
    // (a rebuffer longer than the 1 s threshold, far below the 8 s jump reset).
    const chase = () => {
      const player = makePlayer();
      const stamp = Date.now() - 20_000;
      let lag = true;
      player.getCurrentPositionMs.mockImplementation(async () => Date.now() - stamp - (lag ? 3000 : 0));
      useStore.getState().setState(roomState(1, { state: 'playing', positionMs: 0, updatedAtServerMs: stamp }));
      const seeks: number[] = [];
      player.seekToMs.mockImplementation(async () => {
        seeks.push(Date.now());
      });
      return { player, seeks, setLag: (v: boolean) => (lag = v) };
    };

    it('backs off when every seek leaves the player behind again (slow rebuffer chase)', async () => {
      const { player, seeks } = chase();
      const { unmount } = renderHook(() => useDriftCorrection(player, true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      // A fixed 3 s cooldown re-seeked every 4.5 s (13 times a minute).
      expect(seeks.length).toBeLessThanOrEqual(5);
      const gaps = seeks.slice(1).map((v, i) => v - seeks[i]);
      for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThan(gaps[i - 1]);
      unmount();
    });

    it('resets the backoff once drift is back in range', async () => {
      const { player, seeks, setLag } = chase();
      const { unmount } = renderHook(() => useDriftCorrection(player, true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000); // several seeks: the wait has grown past 6 s
      });
      setLag(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000); // in sync: counter resets
      });
      const before = seeks.length;
      setLag(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      const relapse = seeks.slice(before);
      expect(relapse.length).toBeGreaterThanOrEqual(2);
      // Base 3 s wait again (one 1.5 s tick later), not the 12 s the grown backoff would impose.
      expect(relapse[1] - relapse[0]).toBeLessThanOrEqual(6000);
      unmount();
    });

    it('keeps backing off under a persistent 10 s lag (a big offset is not a new jump)', async () => {
      const player = makePlayer();
      const stamp = Date.now() - 30_000;
      player.getCurrentPositionMs.mockImplementation(async () => Date.now() - stamp - 10_000);
      useStore.getState().setState(roomState(1, { state: 'playing', positionMs: 0, updatedAtServerMs: stamp }));
      const seeks: number[] = [];
      player.seekToMs.mockImplementation(async () => {
        seeks.push(Date.now());
      });
      const { unmount } = renderHook(() => useDriftCorrection(player, true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });
      const gaps = seeks.slice(1).map((v, i) => v - seeks[i]);
      expect(gaps.length).toBeGreaterThanOrEqual(4);
      for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]);
      expect(gaps[gaps.length - 1]).toBeGreaterThan(gaps[0]);
      unmount();
    });

    it('resets the backoff when the offset itself jumps (a seek by the host)', async () => {
      const player = makePlayer();
      const stamp = Date.now() - 30_000;
      let extra = 3000;
      player.getCurrentPositionMs.mockImplementation(async () => Date.now() - stamp - extra);
      useStore.getState().setState(roomState(1, { state: 'playing', positionMs: 0, updatedAtServerMs: stamp }));
      const seeks: number[] = [];
      player.seekToMs.mockImplementation(async () => {
        seeks.push(Date.now());
      });
      const { unmount } = renderHook(() => useDriftCorrection(player, true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40_000); // backoff grown
      });
      const before = seeks.length;
      extra = 15_000; // lag jumps by 12 s between two measurements
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });
      expect(seeks.length).toBeGreaterThan(before); // corrected promptly despite the grown wait
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

  it('never seeks past the end and advances once when the user can control', async () => {
    const player = makePlayer();
    seed(1, STALE);
    const { unmount } = renderHook(() => useDriftCorrection(player, true, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000); // several drift ticks
    });
    expect(player.seekToMs).not.toHaveBeenCalled();
    expect(advanceMock).toHaveBeenCalledTimes(1);
    expect(advanceMock).toHaveBeenCalledWith('r1', 't1');
    unmount();
  });

  it('does not double-advance on a re-publication of the same stale transport', async () => {
    const player = makePlayer();
    seed(1, STALE);
    const { unmount } = renderHook(() => useDriftCorrection(player, true, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000); // the first advance has fired
    });
    expect(advanceMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      seed(2, { ...STALE, positionMs: 1 }); // same stale transport republished, inside the retry window
      await vi.advanceTimersByTimeAsync(5000);
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

  it('never seeks a listener whose transport is already past the end, and stops playing once decided', async () => {
    const player = makePlayer();
    player.getDurationMs.mockResolvedValue(0);
    seed(1, STALE);
    const { unmount } = renderHook(() => useDriftCorrection(player, true, false));
    expect(player.seekToMs).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000); // hold (10 s after PLAYING) is over
    });
    player.play.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(player.seekToMs).not.toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();
    unmount();
  });

  it('trusts the longer of the catalogue and the player duration (music video longer than the entry)', async () => {
    const player = makePlayer();
    player.getDurationMs.mockResolvedValue(270_000); // 4:30 video, 3:43 catalogue entry
    seed(1, { state: 'playing', positionMs: 0, updatedAtServerMs: NOW - 240_000 }); // 4:00 in
    const { unmount } = renderHook(() => useDriftCorrection(player, true, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(advanceMock).not.toHaveBeenCalled();
    expect(player.seekToMs).toHaveBeenCalled();
    unmount();
  });

  it('falls back to the player duration for a track with none and stops the ENDED loop', async () => {
    const player = makePlayer();
    player.getDurationMs.mockResolvedValue(149_000); // 2:29, no catalogue duration
    player.getCurrentPositionMs.mockResolvedValue(149_000);
    seed(1, { state: 'playing', positionMs: 0, updatedAtServerMs: NOW - 100_000 }, 0);
    const { unmount } = renderHook(() => useDriftCorrection(player, true, false));
    player.seekToMs.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000); // learns 149 s while 'playing'
    });
    vi.setSystemTime(NOW + 60_000); // room never moved: expected is now 160 s, past 149 s + grace
    player.seekToMs.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(player.seekToMs).not.toHaveBeenCalled();
    expect(advanceMock).not.toHaveBeenCalled(); // a listener only waits
    unmount();
  });

  it('a controller advances a track with no catalogue duration once the player says it ended', async () => {
    const player = makePlayer();
    player.getDurationMs.mockResolvedValue(149_000);
    seed(1, { state: 'playing', positionMs: 0, updatedAtServerMs: NOW - 100_000 }, 0);
    const { unmount } = renderHook(() => useDriftCorrection(player, true, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    vi.setSystemTime(NOW + 60_000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(advanceMock).toHaveBeenCalledTimes(1);
    expect(advanceMock).toHaveBeenCalledWith('r1', 't1');
    unmount();
  });

  it('does not cut a longer video when the first duration read is 0 (metadata still loading)', async () => {
    const player = makePlayer();
    player.getDurationMs.mockResolvedValueOnce(0).mockResolvedValue(270_000);
    // Reload at 4:00 into a 4:30 video whose catalogue entry says 3:43.
    seed(1, { state: 'playing', positionMs: 0, updatedAtServerMs: NOW - 240_000 });
    const { unmount } = renderHook(() => useDriftCorrection(player, true, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(advanceMock).not.toHaveBeenCalled();
    unmount();
  });

  it('still advances a stale room whose player never reports a duration (bounded hold)', async () => {
    const player = makePlayer();
    player.getDurationMs.mockResolvedValue(0);
    seed(1, STALE);
    const { unmount } = renderHook(() => useDriftCorrection(player, true, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(advanceMock).not.toHaveBeenCalled(); // held while the duration is unknown
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(advanceMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not read the duration while the player is not PLAYING', async () => {
    const player = { ...makePlayer(), isPlaying: vi.fn(() => false) };
    seed(1, STALE);
    const { unmount } = renderHook(() => useDriftCorrection(player, true, false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(player.getDurationMs).not.toHaveBeenCalled();
    unmount();
  });

  it('distrusts a player duration over 3x the catalogue (hour-long loop): the catalogue end stands', async () => {
    const player = makePlayer();
    player.getDurationMs.mockResolvedValue(3_829_000); // 63:49 for a 2:49 entry
    seed(1, { state: 'playing', positionMs: 0, updatedAtServerMs: NOW - 400_000 }, 169_000);
    const { unmount } = renderHook(() => useDriftCorrection(player, true, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(advanceMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  // A YouTube-like sequence: isPlaying false while autoplay is blocked or the
  // first buffer loads, then true; the duration is 0 until metadata arrives.
  it('does not advance while autoplay is blocked, and resumes play() instead', async () => {
    const player = { ...makePlayer(), isPlaying: vi.fn(() => false), isPaused: vi.fn(() => true) };
    player.getDurationMs.mockResolvedValue(270_000);
    seed(1, { state: 'playing', positionMs: 0, updatedAtServerMs: NOW - 230_000 }); // 3:50 into a 4:30 video, entry says 3:43
    const { unmount } = renderHook(() => useDriftCorrection(player, true, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000); // longer than the 10 s hold
    });
    expect(advanceMock).not.toHaveBeenCalled();
    expect(player.play.mock.calls.length).toBeGreaterThanOrEqual(2); // initial + the one resume
    expect(player.seekToMs).not.toHaveBeenCalled();
    // The user finally allows playback: PLAYING, duration known, not cut short.
    player.isPlaying.mockReturnValue(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(advanceMock).not.toHaveBeenCalled();
    unmount();
  });

  it('starts the hold clock only after the first PLAYING, however long the buffer took', async () => {
    const player = { ...makePlayer(), isPlaying: vi.fn(() => false), isPaused: vi.fn(() => false) };
    player.getDurationMs.mockResolvedValue(0); // metadata not there yet
    seed(1, { state: 'playing', positionMs: 0, updatedAtServerMs: NOW - 230_000 });
    const { unmount } = renderHook(() => useDriftCorrection(player, true, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000); // buffering for 20 s
    });
    expect(advanceMock).not.toHaveBeenCalled();
    player.isPlaying.mockReturnValue(true); // PLAYING, duration still 0 for a moment
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(advanceMock).not.toHaveBeenCalled(); // inside the 10 s hold from first PLAYING
    player.getDurationMs.mockResolvedValue(270_000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(advanceMock).not.toHaveBeenCalled(); // learned 4:30, 4:00 in
    unmount();
  });
});

describe('useDriftCorrection when the queue has ended', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useStore.setState({ state: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The server leaves the transport "playing" at 0 when the last track ends
  // and nothing follows (radio still fetching, or off). The player still holds
  // the finished track (Spotify; YouTube unmounts): resuming and seeking it to 0 replays the same song.
  it('does not replay the finished track while nothing is now-playing', async () => {
    const player = makePlayer();
    useStore.getState().setState({
      ...roomState(2, { state: 'playing', positionMs: 0, updatedAtServerMs: NOW }),
      queue: [],
      nowPlayingId: undefined,
    });
    const { unmount } = renderHook(() => useDriftCorrection(player, true, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(player.play).not.toHaveBeenCalled();
    expect(player.seekToMs).not.toHaveBeenCalled();
    unmount();
  });

  it('does not resume the old player when a now-playing track has no source yet', async () => {
    const player = makePlayer();
    useStore.getState().setState({
      ...roomState(3, { state: 'playing', positionMs: 0, updatedAtServerMs: NOW }),
      queue: [{ id: 'radio1', title: 'R', artist: 'A', sources: {}, addedBy: 'radio' }],
      nowPlayingId: 'radio1',
    });
    // client.tsx hands the hook no active player while the source is unresolved.
    const { unmount } = renderHook(() => useDriftCorrection(null, true, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(player.play).not.toHaveBeenCalled();
    expect(player.seekToMs).not.toHaveBeenCalled();
    unmount();
  });

  describe('background tab', () => {
    const setHidden = (hidden: boolean) =>
      Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
    afterEach(() => setHidden(false));

    it('keeps resuming a player the browser paused while the page is hidden', async () => {
      setHidden(true);
      const player = { ...makePlayer(), isPlaying: vi.fn(() => false), isPaused: vi.fn(() => true) };
      useStore.getState().setState(roomState(1, { state: 'playing', positionMs: 0, updatedAtServerMs: Date.now() }));
      const { unmount } = renderHook(() => useDriftCorrection(player, true));
      const initial = player.play.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      // A visible page tries once; a hidden one keeps trying every few seconds.
      expect(player.play.mock.calls.length - initial).toBeGreaterThanOrEqual(4);
      unmount();
    });

    it('checks the player at once when the page comes back, not at the next tick', async () => {
      const player = { ...makePlayer(), isPlaying: vi.fn(() => false), isPaused: vi.fn(() => true) };
      useStore.getState().setState(roomState(1, { state: 'playing', positionMs: 0, updatedAtServerMs: Date.now() }));
      const { unmount } = renderHook(() => useDriftCorrection(player, true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600); // first tick used the one visible resume
      });
      const before = player.play.mock.calls.length;
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(player.play.mock.calls.length).toBe(before + 1);
      unmount();
    });

    it('never pauses the player when the page is hidden', async () => {
      const player = makePlayer();
      useStore.getState().setState(roomState(1, PLAYING));
      const { unmount } = renderHook(() => useDriftCorrection(player, true));
      setHidden(true);
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(player.pause).not.toHaveBeenCalled();
      unmount();
    });
  });
});
