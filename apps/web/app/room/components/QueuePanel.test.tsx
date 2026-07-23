import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueuePanel } from './QueuePanel';
import { useStore } from '@/lib/realtime';
import type { RoomState, TrackRef } from '@cojam/shared';

// Only the RPC functions are mocked; the component drives the real zustand
// store (seeded below) so the render reflects actual app state flow.
const rpcMocks = vi.hoisted(() => ({
  queueRemove: vi.fn(async () => {}),
  nowPlayingSet: vi.fn(async () => {}),
  queueReorder: vi.fn(async () => {}),
}));

vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  queueRemove: rpcMocks.queueRemove,
  nowPlayingSet: rpcMocks.nowPlayingSet,
  queueReorder: rpcMocks.queueReorder,
}));

const track = (id: string, title: string): TrackRef => ({
  id,
  title,
  artist: 'Some Artist',
  durationMs: 180_000,
  sources: {},
  addedBy: 'Ana',
});

const roomState = (queue: TrackRef[]): RoomState => ({
  roomId: 'r1',
  queue,
  radioEnabled: false,
  version: 1,
});

describe('QueuePanel undo window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStore.setState({ state: roomState([track('t1', 'First Song')]) });
    rpcMocks.queueRemove.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the undo window on Remove without calling queue.remove yet', () => {
    render(<QueuePanel roomId="r1" canControl />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.getByText('Removed First Song')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(rpcMocks.queueRemove).not.toHaveBeenCalled();
  });

  it('cancels the removal when Undo is clicked inside the window', async () => {
    render(<QueuePanel roomId="r1" canControl />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(screen.queryByText('Removed First Song')).not.toBeInTheDocument();

    // The pending 4s timer must have been cleared: no RPC fires on expiry.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(rpcMocks.queueRemove).not.toHaveBeenCalled();
  });

  it('calls queue.remove when the window expires without Undo', async () => {
    render(<QueuePanel roomId="r1" canControl />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(rpcMocks.queueRemove).toHaveBeenCalledWith('r1', 't1');
    expect(screen.queryByText('Removed First Song')).not.toBeInTheDocument();
  });
});
