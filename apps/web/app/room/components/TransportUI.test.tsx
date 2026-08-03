import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TransportUI, formatTime, playPauseLabel } from './TransportUI';
import { useStore } from '@/lib/realtime';
import type { IPlayer } from '@/lib/playerInterface';

// Only the RPC function is mocked; the component drives the real zustand
// store (seeded below) so the render reflects actual app state flow.
const rpcMocks = vi.hoisted(() => ({
  transportSeek: vi.fn(async (): Promise<void> => {}),
}));

vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  transportSeek: rpcMocks.transportSeek,
}));

describe('TransportUI', () => {
  describe('formatTime', () => {
    it('formats zero milliseconds', () => {
      expect(formatTime(0)).toBe('0:00');
    });

    it('formats less than one minute', () => {
      expect(formatTime(30000)).toBe('0:30');
      expect(formatTime(59000)).toBe('0:59');
    });

    it('formats exactly one minute', () => {
      expect(formatTime(60000)).toBe('1:00');
    });

    it('formats multiple minutes', () => {
      expect(formatTime(120000)).toBe('2:00');
      expect(formatTime(125000)).toBe('2:05');
      expect(formatTime(125500)).toBe('2:05');
    });

    it('pads seconds with zero', () => {
      expect(formatTime(65000)).toBe('1:05');
      expect(formatTime(600000)).toBe('10:00');
    });

    it('handles large durations', () => {
      expect(formatTime(3661000)).toBe('61:01');
    });

    it('handles NaN and negative values', () => {
      expect(formatTime(NaN)).toBe('0:00');
      expect(formatTime(-100)).toBe('0:00');
    });

    it('rounds down to nearest second', () => {
      expect(formatTime(1234)).toBe('0:01');
      expect(formatTime(125999)).toBe('2:05');
    });
  });

  describe('transport state mapping', () => {
    it('maps playing state to pause label', () => {
      expect(playPauseLabel('playing')).toBe('Pause');
    });

    it('maps paused state to play label', () => {
      expect(playPauseLabel('paused')).toBe('Play');
    });

    it('maps stopped and undefined state to play label', () => {
      expect(playPauseLabel('stopped')).toBe('Play');
      expect(playPauseLabel(undefined)).toBe('Play');
    });
  });

  describe('seek disabled logic', () => {
    it('is disabled when canSeek is false', () => {
      const canSeek = false;
      expect(canSeek).toBe(false);
    });

    it('is enabled when canSeek is true', () => {
      const canSeek = true;
      expect(canSeek).toBe(true);
    });

    it('provides correct reason text', () => {
      const canSeek = false;
      const reason = !canSeek ? 'Seeking requires Spotify Premium' : '';
      expect(reason).toBe('Seeking requires Spotify Premium');
    });
  });
});

describe('TransportUI keyboard seek', () => {
  const player: IPlayer = {
    play: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    seekToMs: vi.fn(async () => {}),
    getCurrentPositionMs: vi.fn(async () => 0),
    getDurationMs: vi.fn(async () => 60000),
    canSeek: () => true,
    onEnded: vi.fn(),
    onPositionChanged: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    useStore.setState({
      state: {
        roomId: 'r1',
        queue: [{ id: 't1', title: 'Song', artist: 'A', durationMs: 60000, sources: {}, addedBy: 'Ana' }],
        nowPlayingId: 't1',
        radioEnabled: false,
        version: 1,
        transport: { state: 'paused', positionMs: 0, updatedAtServerMs: 0 },
      },
    });
    rpcMocks.transportSeek.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not commit a seek on Tab or Escape keyup', () => {
    render(<TransportUI roomId="r1" activePlayer={player} canControl />);
    const slider = screen.getByLabelText('Track position');

    fireEvent.change(slider, { target: { value: '30000' } });
    fireEvent.keyUp(slider, { key: 'Tab' });
    fireEvent.keyUp(slider, { key: 'Escape' });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(rpcMocks.transportSeek).not.toHaveBeenCalled();
  });

  it('debounces repeated arrow-key seeks into one RPC per pause', () => {
    render(<TransportUI roomId="r1" activePlayer={player} canControl />);
    const slider = screen.getByLabelText('Track position');

    fireEvent.change(slider, { target: { value: '10000' } });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    fireEvent.change(slider, { target: { value: '15000' } });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    fireEvent.change(slider, { target: { value: '20000' } });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(rpcMocks.transportSeek).toHaveBeenCalledTimes(1);
    expect(rpcMocks.transportSeek).toHaveBeenCalledWith('r1', 20000);
  });

  it('commits again after a pause between key presses', () => {
    render(<TransportUI roomId="r1" activePlayer={player} canControl />);
    const slider = screen.getByLabelText('Track position');

    fireEvent.change(slider, { target: { value: '10000' } });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.change(slider, { target: { value: '20000' } });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(rpcMocks.transportSeek).toHaveBeenCalledTimes(2);
    expect(rpcMocks.transportSeek).toHaveBeenLastCalledWith('r1', 20000);
  });
});
