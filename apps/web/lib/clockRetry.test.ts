import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { measureClockOffsetWithRetry, cancelClockMeasure, requestClockRemeasure } from './realtime';

// No Centrifuge connection in this file: sync.ping rejects ("Not connected"),
// so every attempt fails and schedules the next retry timer.
describe('clock offset retry timers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cancelClockMeasure();
    vi.useRealTimers();
  });

  it('schedules a retry on failure and cancelClockMeasure clears it', async () => {
    measureClockOffsetWithRetry();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    cancelClockMeasure();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('throttles tick-driven re-measures to one chain per 30 s', async () => {
    vi.setSystemTime(10_000_000);
    requestClockRemeasure();
    await vi.advanceTimersByTimeAsync(0);
    cancelClockMeasure();
    requestClockRemeasure(); // within 30 s: ignored
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(10_031_000);
    requestClockRemeasure();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
  });
});
