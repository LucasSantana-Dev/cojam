import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSkipUnplayable, SKIP_UNPLAYABLE_DELAY_MS } from './useSkipUnplayable';

const rt = vi.hoisted(() => ({ skip: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime', () => ({
  nowPlayingSkipUnplayable: rt.skip,
  isPermissionDeniedError: () => false,
}));

type Props = { now: string | undefined; canSkip: boolean };

describe('useSkipUnplayable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rt.skip.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  const setup = (initial: Props) =>
    renderHook((p: Props) => useSkipUnplayable('r1', p.now, p.canSkip), { initialProps: initial });

  it('a controller skips once, after the delay', () => {
    const { result, rerender } = setup({ now: 't1', canSkip: true });
    act(() => result.current('t1'));
    act(() => void vi.advanceTimersByTime(SKIP_UNPLAYABLE_DELAY_MS - 1));
    expect(rt.skip).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(rt.skip).toHaveBeenCalledTimes(1);
    expect(rt.skip).toHaveBeenCalledWith('r1', 't1');
    // the same failure reported again, or a rerender, never skips twice
    act(() => result.current('t1'));
    rerender({ now: 't1', canSkip: true });
    act(() => void vi.advanceTimersByTime(10_000));
    expect(rt.skip).toHaveBeenCalledTimes(1);
  });

  it('a non-controller never skips', () => {
    const { result } = setup({ now: 't1', canSkip: false });
    act(() => result.current('t1'));
    act(() => void vi.advanceTimersByTime(10_000));
    expect(rt.skip).not.toHaveBeenCalled();
  });

  it('does not skip when the track changed during the delay', () => {
    const { result, rerender } = setup({ now: 't1', canSkip: true });
    act(() => result.current('t1'));
    act(() => void vi.advanceTimersByTime(1000));
    rerender({ now: 't2', canSkip: true });
    act(() => void vi.advanceTimersByTime(10_000));
    expect(rt.skip).not.toHaveBeenCalled();
  });

  it('does not skip when playback recovers (null) during the delay', () => {
    const { result } = setup({ now: 't1', canSkip: true });
    act(() => result.current('t1'));
    act(() => void vi.advanceTimersByTime(1000));
    act(() => result.current(null));
    act(() => void vi.advanceTimersByTime(10_000));
    expect(rt.skip).not.toHaveBeenCalled();
  });

  it('ignores an error reported for a track that is not playing', () => {
    const { result } = setup({ now: 't2', canSkip: true });
    act(() => result.current('t1'));
    act(() => void vi.advanceTimersByTime(10_000));
    expect(rt.skip).not.toHaveBeenCalled();
  });
});
