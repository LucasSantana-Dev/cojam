import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, within, waitFor } from '@testing-library/react';
import { QueuePanel, queueArtwork } from './QueuePanel';
import { useStore } from '@/lib/realtime';
import type { RoomState, TrackRef } from '@cojam/shared';

// Only the RPC functions are mocked; the component drives the real zustand
// store (seeded below) so the render reflects actual app state flow.
const rpcMocks = vi.hoisted(() => ({
  queueRemove: vi.fn(async () => {}),
  nowPlayingSet: vi.fn(async () => {}),
  queueReorder: vi.fn(async () => {}),
  voteTrack: vi.fn(async () => {}),
}));

vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  queueRemove: rpcMocks.queueRemove,
  nowPlayingSet: rpcMocks.nowPlayingSet,
  queueReorder: rpcMocks.queueReorder,
  voteTrack: rpcMocks.voteTrack,
}));

// The F4 flag resolves through useRuntimeFeatures: the /env.js runtime
// features map merged over the build-time defaults. Tests inject
// window.__COJAM_ENV__ directly (a stable object per case, as
// useSyncExternalStore requires) instead of mocking the module.
function setQueueVotingEnv(enabled: boolean | undefined) {
  if (enabled === undefined) {
    delete window.__COJAM_ENV__;
  } else {
    window.__COJAM_ENV__ = { features: { queueVoting: enabled } };
  }
}

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

describe('queueArtwork', () => {
  const base: TrackRef = { id: 't1', title: 'T', artist: 'A', sources: {}, addedBy: 'Ana' };

  it('prefers the stored artwork URL', () => {
    expect(queueArtwork({ ...base, artworkUrl: 'https://img/x.jpg' })).toBe('https://img/x.jpg');
  });

  it('derives a YouTube thumb from the video id when no artwork is stored', () => {
    expect(queueArtwork({ ...base, sources: { youtube: { videoId: 'jNQXAC9IVRw', confidence: 1 } } }))
      .toBe('https://i.ytimg.com/vi/jNQXAC9IVRw/mqdefault.jpg');
  });

  it('returns null when nothing can provide art (fallback tile)', () => {
    expect(queueArtwork(base)).toBeNull();
  });
});

describe('QueuePanel thumbs', () => {
  beforeEach(() => {
    useStore.setState({
      state: {
        roomId: 'r1',
        queue: [
          { id: 't1', title: 'With Art', artist: 'A', sources: {}, addedBy: 'Ana', artworkUrl: 'https://img/art.jpg' },
          { id: 't2', title: 'No Art', artist: 'A', sources: {}, addedBy: 'Ana' },
        ],
        radioEnabled: false,
        version: 1,
      },
    });
  });

  it('renders album art when present and a fallback tile otherwise', () => {
    const { container } = render(<QueuePanel roomId="r1" canControl />);
    const rows = screen.getAllByTestId('queue-item');
    const img = rows[0].querySelector('img.queue-thumb');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', expect.stringContaining('https://img/art.jpg'));
    expect(rows[1].querySelector('img.queue-thumb')).toBeNull();
    expect(container.querySelectorAll('.queue-thumb-fallback')).toHaveLength(1);
  });
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

describe('QueuePanel voting (F4)', () => {
  const votingState = (votes: RoomState['votes'], nowPlayingId?: string): RoomState => ({
    roomId: 'r1',
    queue: [track('t1', 'First Song'), track('t2', 'Second Song')],
    nowPlayingId,
    radioEnabled: false,
    version: 1,
    votes,
  });

  beforeEach(() => {
    setQueueVotingEnv(true);
    useStore.setState({
      state: votingState({ t2: ['user:a', 'user:b'] }),
      connected: true,
      myVotes: {},
    });
    rpcMocks.voteTrack.mockReset();
    rpcMocks.voteTrack.mockResolvedValue(undefined);
  });

  afterEach(() => {
    setQueueVotingEnv(undefined);
  });

  it('renders the vote button with the live count for every member', () => {
    render(<QueuePanel roomId="r1" canControl={false} />);

    const rows = screen.getAllByTestId('queue-item');
    expect(screen.getAllByRole('button', { name: 'Vote' })).toHaveLength(2);
    expect(within(rows[0]).getByTestId('vote-count')).toHaveTextContent('0');
    expect(within(rows[1]).getByTestId('vote-count')).toHaveTextContent('2');
  });

  it('hides the vote controls when the flag is off', () => {
    setQueueVotingEnv(false);
    render(<QueuePanel roomId="r1" canControl />);

    expect(screen.queryByRole('button', { name: 'Vote' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('vote-count')).not.toBeInTheDocument();
  });

  it('disables voting while disconnected', () => {
    useStore.setState({ connected: false });
    render(<QueuePanel roomId="r1" canControl />);

    expect(screen.getAllByRole('button', { name: 'Vote' })[0]).toBeDisabled();
  });

  it('marks the track voted only after the RPC succeeds', async () => {
    render(<QueuePanel roomId="r1" canControl />);
    const row = screen.getAllByTestId('queue-item')[0];
    const button = within(row).getByRole('button', { name: 'Vote' });

    fireEvent.click(button);

    await waitFor(() => expect(useStore.getState().myVotes.t1).toBe(true));
    expect(rpcMocks.voteTrack).toHaveBeenCalledWith('r1', 't1');
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not mark voted when the RPC fails and surfaces the error inline', async () => {
    rpcMocks.voteTrack.mockRejectedValueOnce(new Error('too many requests, slow down'));
    render(<QueuePanel roomId="r1" canControl />);
    const row = screen.getAllByTestId('queue-item')[0];

    fireEvent.click(within(row).getByRole('button', { name: 'Vote' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('too many requests, slow down');
    expect(useStore.getState().myVotes.t1).toBeUndefined();
    expect(within(row).getByRole('button', { name: 'Vote' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('marks the most-voted queued track as the listeners pick, excluding now playing', () => {
    // t2 has more votes but is now playing, so the pick falls to t1.
    useStore.setState({ state: votingState({ t2: ['user:a', 'user:b'], t1: ['user:c'] }, 't2') });
    render(<QueuePanel roomId="r1" canControl />);

    const rows = screen.getAllByTestId('queue-item');
    expect(within(rows[0]).getByTestId('listeners-pick')).toBeInTheDocument();
    expect(within(rows[1]).queryByTestId('listeners-pick')).not.toBeInTheDocument();
  });

  it('shows no listeners pick when every count is zero', () => {
    useStore.setState({ state: votingState(undefined) });
    render(<QueuePanel roomId="r1" canControl />);

    expect(screen.queryByTestId('listeners-pick')).not.toBeInTheDocument();
  });
});
