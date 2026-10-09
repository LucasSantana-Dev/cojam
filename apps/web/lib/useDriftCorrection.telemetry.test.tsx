import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useDriftCorrection } from './useDriftCorrection';
import { useStore } from './realtime';
import type { RoomState } from '@cojam/shared';

const telemetryMock = vi.hoisted(() => ({ trackSyncDrift: vi.fn() }));
vi.mock('./telemetry', () => telemetryMock);

const T0 = 1_000_000;
let version = 0;

// A player that always reads `offset` ms ahead of the expected position (the
// transport was stamped at T0 with position 1000, so expected = 1000 + elapsed).
function makePlayer(offset: number, kind: 'youtube' | 'spotify' | 'none' = 'youtube') {
  return {
    kind: kind === 'none' ? undefined : kind,
    play: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    seekToMs: vi.fn(async () => {}),
    getCurrentPositionMs: vi.fn(async () => 1000 + (Date.now() - T0) + offset),
    getDurationMs: vi.fn(async () => 600_000),
    canSeek: vi.fn(() => true),
    isPlaying: vi.fn(() => true),
    onEnded: vi.fn(() => {}),
    onPositionChanged: vi.fn(() => {}),
  };
}

const seed = (nowPlayingId = 't0') =>
  useStore.getState().setState({
    roomId: 'r1',
    queue: [],
    radioEnabled: false,
    nowPlayingId,
    version: ++version,
    transport: { state: 'playing', positionMs: 1000, updatedAtServerMs: T0 },
  } as RoomState);

describe('sync_drift sampling in useDriftCorrection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    telemetryMock.trackSyncDrift.mockClear();
    useStore.setState({ state: null });
    version = 0;
    window.__COJAM_ENV__ = { features: { telemetry: true } };
  });

  afterEach(() => {
    cleanup();
    delete window.__COJAM_ENV__;
    vi.useRealTimers();
  });

  it('samples about 3 s after the track starts, then every 30 s, with the documented fields', async () => {
    seed();
    const player = makePlayer(400);
    const { unmount } = renderHook(() => useDriftCorrection(player, true));

    await vi.advanceTimersByTimeAsync(2500);
    expect(telemetryMock.trackSyncDrift).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(telemetryMock.trackSyncDrift).toHaveBeenCalledTimes(1);
    const sample = telemetryMock.trackSyncDrift.mock.calls[0][0];
    expect(Object.keys(sample).sort()).toEqual(['canSeek', 'driftMs', 'hidden', 'player', 'rttMs']);
    expect(sample).toMatchObject({ player: 'youtube', canSeek: true, hidden: false });
    expect(Math.abs(sample.driftMs - 400)).toBeLessThan(5);
    expect(JSON.stringify(sample)).not.toMatch(/r1|t0/);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(telemetryMock.trackSyncDrift).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('samples a Spotify player that cannot seek too', async () => {
    seed();
    const player = makePlayer(-50, 'spotify');
    player.canSeek.mockReturnValue(false);
    renderHook(() => useDriftCorrection(player, true));
    await vi.advanceTimersByTimeAsync(4000);
    expect(telemetryMock.trackSyncDrift).toHaveBeenCalledWith(expect.objectContaining({ player: 'spotify', canSeek: false }));
  });

  it('takes a follow-up sample after a corrective seek, well before the 30 s cadence', async () => {
    seed();
    let offset = 0;
    const player = makePlayer(0);
    player.getCurrentPositionMs.mockImplementation(async () => 1000 + (Date.now() - T0) + offset);
    renderHook(() => useDriftCorrection(player, true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(telemetryMock.trackSyncDrift).toHaveBeenCalledTimes(1);
    expect(player.seekToMs).toHaveBeenCalledTimes(1); // the mount seek only

    offset = 5000; // the player lurches: the next tick seeks
    await vi.advanceTimersByTimeAsync(1000);
    expect(player.seekToMs).toHaveBeenCalledTimes(2);
    expect(telemetryMock.trackSyncDrift).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(telemetryMock.trackSyncDrift).toHaveBeenCalledTimes(2);
  });

  it('samples again about 3 s after a track change', async () => {
    seed('t0');
    const player = makePlayer(0);
    renderHook(() => useDriftCorrection(player, true));
    await vi.advanceTimersByTimeAsync(4000);
    expect(telemetryMock.trackSyncDrift).toHaveBeenCalledTimes(1);
    seed('t1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(telemetryMock.trackSyncDrift).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(telemetryMock.trackSyncDrift).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the telemetry flag is off', async () => {
    seed();
    window.__COJAM_ENV__ = { features: { telemetry: false } };
    renderHook(() => useDriftCorrection(makePlayer(0), true));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(telemetryMock.trackSyncDrift).not.toHaveBeenCalled();
  });

  it('does nothing for a player that does not name its provider', async () => {
    seed();
    renderHook(() => useDriftCorrection(makePlayer(0, 'none'), true));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(telemetryMock.trackSyncDrift).not.toHaveBeenCalled();
  });

  it('stays quiet while paused', async () => {
    seed();
    useStore.getState().setState({ ...useStore.getState().state!, version: ++version, transport: { state: 'paused', positionMs: 1000, updatedAtServerMs: T0 } } as RoomState);
    renderHook(() => useDriftCorrection(makePlayer(0), true));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(telemetryMock.trackSyncDrift).not.toHaveBeenCalled();
  });
});
