import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActivityRail } from './ActivityRail';
import { useStore } from '@/lib/realtime';
import type { RoomState, TrackRef } from '@cojam/shared';

// Keep the real store; control the measured sync.ping offset per test.
const clockMocks = vi.hoisted(() => ({ offsetMs: 0 }));
vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  getClockOffsetMs: vi.fn(() => clockMocks.offsetMs),
}));

const NOW = 1_760_000_000_000;

function track(id: string, addedBy: string, title: string, addedAt?: number): TrackRef {
  return {
    id,
    title,
    artist: 'Artist',
    sources: {},
    addedBy,
    ...(addedAt !== undefined ? { addedAt } : {}),
  };
}

function seedQueue(queue: TrackRef[]) {
  const state: RoomState = { roomId: 'r1', queue, radioEnabled: false, version: 1 };
  useStore.setState({ state });
}

describe('ActivityRail (#206)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    clockMocks.offsetMs = 0;
    useStore.setState({ state: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists queue adds newest-first with relative times from addedAt', () => {
    seedQueue([
      track('t1', 'Alice', 'Older Song', NOW - 10 * 60_000),
      track('t2', 'Bob', 'Newest Song', NOW - 2 * 60_000),
      track('t3', 'Cid', 'Middle Song', NOW - 5 * 60_000),
    ]);

    render(<ActivityRail />);

    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Bob added Newest Song');
    expect(items[0]).toHaveTextContent('2m ago');
    expect(items[1]).toHaveTextContent('Cid added Middle Song');
    expect(items[1]).toHaveTextContent('5m ago');
    expect(items[2]).toHaveTextContent('Alice added Older Song');
    expect(items[2]).toHaveTextContent('10m ago');
  });

  it('skips tracks with no server timestamp (legacy queue entries)', () => {
    seedQueue([track('t1', 'Alice', 'Legacy Song'), track('t2', 'Bob', 'Stamped Song', NOW - 60_000)]);

    render(<ActivityRail />);

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Bob added Stamped Song');
    expect(screen.queryByText(/Legacy Song/)).toBeNull();
  });

  it('renders nothing when no track carries a timestamp', () => {
    seedQueue([track('t1', 'Alice', 'Legacy Song')]);

    const { container } = render(<ActivityRail />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Activity')).toBeNull();
  });

  it('applies the measured clock offset so skewed clients agree on the age', () => {
    // Client clock runs 2 minutes behind the server; without the offset the
    // add would look like it happened 2 minutes in the future.
    clockMocks.offsetMs = 2 * 60_000;
    seedQueue([track('t1', 'Alice', 'Some Song', NOW + 2 * 60_000 - 5 * 60_000)]);

    render(<ActivityRail />);

    expect(screen.getByRole('listitem')).toHaveTextContent('5m ago');
  });
});
