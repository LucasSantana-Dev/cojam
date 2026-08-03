import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDriftCorrection } from './useDriftCorrection';
import { useStore } from './realtime';
import type { RoomState, TransportState } from '@cojam/shared';

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
});
