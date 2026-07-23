import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { LiveRoomsStrip, LiveRoomsSlot } from './LiveRoomsStrip';
import type { PublicRoomSummary } from '@cojam/shared';

// next/link outside an app-router render tree; a plain anchor is enough here.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

// The subscription is captured so tests can drive directory updates directly;
// no centrifuge client is ever constructed.
const publicRoomsMock = vi.hoisted(() => ({
  listener: null as ((rooms: PublicRoomSummary[]) => void) | null,
  subscribeCalls: 0,
  unsubscribeCalls: 0,
}));

vi.mock('@/lib/publicRooms', () => ({
  subscribePublicRooms: (listener: (rooms: PublicRoomSummary[]) => void) => {
    publicRoomsMock.listener = listener;
    publicRoomsMock.subscribeCalls++;
    return () => {
      publicRoomsMock.unsubscribeCalls++;
    };
  },
}));

const fixtures: PublicRoomSummary[] = [
  { roomId: 'NEON42', name: 'Neon Room', memberCount: 7, nowPlaying: { title: 'Instant Crush', artist: 'Daft Punk' } },
  { roomId: 'ABC123', memberCount: 3 },
];

describe('LiveRoomsStrip', () => {
  it('renders cards from summaries: label, member count, now playing, join href', () => {
    render(<LiveRoomsStrip rooms={fixtures} />);

    expect(screen.getByText('Neon Room')).toBeInTheDocument();
    // No host-set name: the room code is the label.
    expect(screen.getByText('ABC123')).toBeInTheDocument();
    expect(screen.getByText('7 listening')).toBeInTheDocument();
    expect(screen.getByText('3 listening')).toBeInTheDocument();
    expect(screen.getByText('Instant Crush')).toBeInTheDocument();
    expect(screen.getByText('Daft Punk')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: /Neon Room/ })).toHaveAttribute('href', '/room/NEON42');
    expect(screen.getByRole('link', { name: /ABC123/ })).toHaveAttribute('href', '/room/ABC123');
  });

  it('renders a placeholder instead of now-playing when nothing is queued', () => {
    render(<LiveRoomsStrip rooms={[fixtures[1]]} />);
    expect(screen.getByText('Nothing playing yet')).toBeInTheDocument();
  });

  it('caps the strip at 5 cards', () => {
    const many: PublicRoomSummary[] = Array.from({ length: 8 }, (_, i) => ({
      roomId: `ROOM${i}`,
      memberCount: 1,
    }));
    render(<LiveRoomsStrip rooms={many} />);
    expect(screen.getAllByRole('link')).toHaveLength(5);
  });
});

describe('LiveRoomsSlot', () => {
  beforeEach(() => {
    publicRoomsMock.listener = null;
    publicRoomsMock.subscribeCalls = 0;
    publicRoomsMock.unsubscribeCalls = 0;
  });

  afterEach(() => {
    delete window.__COJAM_ENV__;
  });

  it('renders the fallback (mock) when the flag is off and never subscribes', () => {
    // No runtime env: the build-time default is publicRooms = false.
    render(<LiveRoomsSlot fallback={<div>example mock</div>} />);

    expect(screen.getByText('example mock')).toBeInTheDocument();
    expect(publicRoomsMock.subscribeCalls).toBe(0);
  });

  it('keeps the fallback on an empty list and swaps to the strip when rooms arrive', () => {
    window.__COJAM_ENV__ = { features: { publicRooms: true } };
    render(<LiveRoomsSlot fallback={<div>example mock</div>} />);

    expect(publicRoomsMock.subscribeCalls).toBe(1);
    // Empty list (initial and after a poll with zero public rooms): mock stays.
    expect(screen.getByText('example mock')).toBeInTheDocument();
    act(() => publicRoomsMock.listener?.([]));
    expect(screen.getByText('example mock')).toBeInTheDocument();

    act(() => publicRoomsMock.listener?.(fixtures));
    expect(screen.queryByText('example mock')).not.toBeInTheDocument();
    expect(screen.getByText('Neon Room')).toBeInTheDocument();
  });

  it('falls back to the mock again when the directory empties', () => {
    window.__COJAM_ENV__ = { features: { publicRooms: true } };
    render(<LiveRoomsSlot fallback={<div>example mock</div>} />);

    act(() => publicRoomsMock.listener?.(fixtures));
    expect(screen.getByText('Neon Room')).toBeInTheDocument();

    act(() => publicRoomsMock.listener?.([]));
    expect(screen.getByText('example mock')).toBeInTheDocument();
  });
});
