import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, within, waitFor } from '@testing-library/react';
import { QueuePanel, queueArtwork } from './QueuePanel';
import { useStore, restoreMyVotes } from '@/lib/realtime';
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
    const img = rows[0].querySelector('.fq-art img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', expect.stringContaining('https://img/art.jpg'));
    expect(rows[1].querySelector('.fq-art img')).toBeNull();
    expect(container.querySelectorAll('.fq-art__fallback')).toHaveLength(1);
  });
});

describe('QueuePanel undo window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStore.setState({ state: roomState([track('t1', 'First Song')]) });
    rpcMocks.queueRemove.mockClear();
    rpcMocks.voteTrack.mockClear();
  });

  afterEach(() => {
    setQueueVotingEnv(undefined);
    vi.useRealTimers();
  });

  it('toggles a row\'s secondary actions from the phone "Mais ações" button (#289)', () => {
    render(<QueuePanel roomId="r1" canControl />);
    const row = screen.getByTestId('queue-item');
    const more = within(row).getByRole('button', { name: 'Mais ações' });

    expect(row).toHaveAttribute('data-more', 'false');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(row).toHaveAttribute('data-more', 'true');
    expect(more).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(more);
    expect(row).toHaveAttribute('data-more', 'false');
  });

  it('opens the undo window on Remove without calling queue.remove yet', () => {
    render(<QueuePanel roomId="r1" canControl />);

    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));

    expect(screen.getByText('Removida: First Song')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Desfazer' })).toBeInTheDocument();
    expect(rpcMocks.queueRemove).not.toHaveBeenCalled();
  });

  it('cancels the removal when Undo is clicked inside the window', async () => {
    render(<QueuePanel roomId="r1" canControl />);

    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer' }));

    expect(screen.queryByText('Removida: First Song')).not.toBeInTheDocument();

    // The pending 4s timer must have been cleared: no RPC fires on expiry.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(rpcMocks.queueRemove).not.toHaveBeenCalled();
  });

  it('calls queue.remove when the window expires without Undo', async () => {
    render(<QueuePanel roomId="r1" canControl />);

    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(rpcMocks.queueRemove).toHaveBeenCalledWith('r1', 't1');
    expect(screen.queryByText('Removida: First Song')).not.toBeInTheDocument();
  });

  // #179: the window must not race concurrent room activity.
  it('cancels the pending remove when the track becomes now playing', async () => {
    render(<QueuePanel roomId="r1" canControl />);

    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));
    expect(screen.getByRole('button', { name: 'Desfazer' })).toBeInTheDocument();

    // The track starts playing mid-window: the pending removal is cancelled
    // and the undo affordance clears.
    act(() => {
      useStore.setState({
        state: { ...roomState([track('t1', 'First Song')]), nowPlayingId: 't1', version: 2 },
      });
    });
    expect(screen.queryByText('Removida: First Song')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(rpcMocks.queueRemove).not.toHaveBeenCalled();
  });

  it('blocks vote, play, and reorder on a pending-removal row', () => {
    setQueueVotingEnv(true);
    useStore.setState({
      state: roomState([track('t1', 'First Song'), track('t2', 'Second Song')]),
      connected: true,
      myVotes: {},
    });
    render(<QueuePanel roomId="r1" canControl />);

    const rows = screen.getAllByTestId('queue-item');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Remover' }));

    // The pending row's interactions are disabled (move-up would otherwise be
    // enabled for the second row), the unaffected row stays interactive.
    const vote = within(rows[1]).getByRole('button', { name: 'Votar' });
    expect(vote).toBeDisabled();
    expect(within(rows[1]).getByRole('button', { name: 'Tocar' })).toBeDisabled();
    expect(within(rows[1]).getByRole('button', { name: 'Mover para cima' })).toBeDisabled();
    expect(within(rows[0]).getByRole('button', { name: 'Votar' })).toBeEnabled();

    // A dispatched click on the blocked row still reaches no RPC.
    fireEvent.click(vote);
    expect(rpcMocks.voteTrack).not.toHaveBeenCalled();
  });

  it('shows no error when the removal fails because the track is already gone', async () => {
    // #211: the server reports an unknown track as a code-400 UserError with
    // the recognizable "track not found" message.
    rpcMocks.queueRemove.mockRejectedValueOnce({ code: 400, message: 'track not found' });
    render(<QueuePanel roomId="r1" canControl />);

    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(rpcMocks.queueRemove).toHaveBeenCalledWith('r1', 't1');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('still surfaces a real removal failure after the window', async () => {
    rpcMocks.queueRemove.mockRejectedValueOnce(new Error('connection closed'));
    render(<QueuePanel roomId="r1" canControl />);

    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(screen.getByRole('alert')).toHaveTextContent('connection closed');
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
    sessionStorage.clear();
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
    expect(screen.getAllByRole('button', { name: 'Votar' })).toHaveLength(2);
    expect(within(rows[0]).getByTestId('vote-count')).toHaveTextContent('0');
    expect(within(rows[1]).getByTestId('vote-count')).toHaveTextContent('2');
  });

  it('hides the vote controls when the flag is off', () => {
    setQueueVotingEnv(false);
    render(<QueuePanel roomId="r1" canControl />);

    expect(screen.queryByRole('button', { name: 'Votar' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('vote-count')).not.toBeInTheDocument();
  });

  it('disables voting while disconnected', () => {
    useStore.setState({ connected: false });
    render(<QueuePanel roomId="r1" canControl />);

    expect(screen.getAllByRole('button', { name: 'Votar' })[0]).toBeDisabled();
  });

  it('marks the track voted only after the RPC succeeds', async () => {
    render(<QueuePanel roomId="r1" canControl />);
    const row = screen.getAllByTestId('queue-item')[0];
    const button = within(row).getByRole('button', { name: 'Votar' });

    fireEvent.click(button);

    await waitFor(() => expect(useStore.getState().myVotes.t1).toBe(true));
    expect(rpcMocks.voteTrack).toHaveBeenCalledWith('r1', 't1');
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not mark voted when the RPC fails and surfaces the error inline', async () => {
    rpcMocks.voteTrack.mockRejectedValueOnce(new Error('too many requests, slow down'));
    render(<QueuePanel roomId="r1" canControl />);
    const row = screen.getAllByTestId('queue-item')[0];

    fireEvent.click(within(row).getByRole('button', { name: 'Votar' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Muitas ações/);
    expect(useStore.getState().myVotes.t1).toBeUndefined();
    expect(within(row).getByRole('button', { name: 'Votar' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('restores the pressed state after a reload, so toggling un-votes (#188)', async () => {
    // Simulate a full reload: the in-memory set is gone and only the
    // sessionStorage entry survives; join restores it before render.
    sessionStorage.setItem('mj_room_votes:r1', JSON.stringify({ t2: true }));
    restoreMyVotes('r1');
    render(<QueuePanel roomId="r1" canControl />);

    const rows = screen.getAllByTestId('queue-item');
    const button = within(rows[1]).getByRole('button', { name: 'Votar' });
    expect(button).toHaveAttribute('aria-pressed', 'true');

    // The control is no longer inverted: clicking a pressed button removes
    // the vote, matching what the server does with the toggle.
    fireEvent.click(button);
    await waitFor(() => expect(useStore.getState().myVotes.t2).toBeUndefined());
    expect(rpcMocks.voteTrack).toHaveBeenCalledWith('r1', 't2');
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('marks the most-voted queued track as the listeners pick, excluding now playing', () => {
    // t2 has more votes but is now playing, so the pick falls to t1.
    useStore.setState({ state: votingState({ t2: ['user:a', 'user:b'], t1: ['user:c'] }, 't2') });
    render(<QueuePanel roomId="r1" canControl />);

    // The playing track is not listed again: one row left, and it is the pick.
    const rows = screen.getAllByTestId('queue-item');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByTestId('listeners-pick')).toBeInTheDocument();
  });

  it('counts only the upcoming tracks in the "A seguir" header and links to the add form', () => {
    useStore.setState({ state: votingState(undefined, 't1') });
    const onAdd = vi.fn();
    render(<QueuePanel roomId="r1" canControl onAdd={onAdd} />);

    // two tracks, one of them playing: one is "a seguir"
    expect(screen.getByRole('heading', { name: /A seguir \(1\)/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Adicionar música/ }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('writes the vote pill in the singular for one vote', () => {
    useStore.setState({ state: votingState({ t1: ['user:a'], t2: ['user:a', 'user:b'] }) });
    render(<QueuePanel roomId="r1" canControl />);

    const rows = screen.getAllByTestId('queue-item');
    expect(rows[0]).toHaveTextContent('1 voto');
    expect(rows[0]).not.toHaveTextContent('1 votos');
    expect(rows[1]).toHaveTextContent('2 votos');
  });

  it('shows no listeners pick when every count is zero', () => {
    useStore.setState({ state: votingState(undefined) });
    render(<QueuePanel roomId="r1" canControl />);

    expect(screen.queryByTestId('listeners-pick')).not.toBeInTheDocument();
  });

  it('names the voters from presence and shows "alguém" for one who left', () => {
    useStore.setState({
      members: [
        { clientId: 'c1', userId: 'a', name: 'Bia' },
        { clientId: 'c2', name: 'Caio' },
      ],
      state: votingState({ t2: ['user:a', 'client:c2', 'user:gone'] }),
    });
    render(<QueuePanel roomId="r1" canControl />);

    const row = screen.getAllByTestId('queue-item')[1];
    const vote = within(row).getByRole('button', { name: 'Votar' });
    expect(vote).toHaveAttribute('title', 'Votaram: Bia, Caio, alguém');
    expect(vote).toHaveAccessibleDescription('Votaram: Bia, Caio, alguém');
  });

  it('does not list the now-playing track in the queue', () => {
    useStore.setState({ state: votingState(undefined, 't1') });
    render(<QueuePanel roomId="r1" canControl />);
    const rows = screen.getAllByTestId('queue-item');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).queryByText(/Tocando agora/)).toBeNull();
  });

  it('swaps the text line for a muted icon when the track has no version on this service', () => {
    useStore.setState({ state: roomState([track('t1', 'A'), track('t2', 'B')]) });
    render(<QueuePanel roomId="r1" canControl listeningOn="spotify" />);
    const icons = screen.getAllByRole('img', { name: 'Sem versão no Spotify' });
    expect(icons.length).toBeGreaterThan(0);
    expect(icons[0]).toHaveAttribute('title', 'Sem versão no Spotify');
    expect(screen.queryByText('Sem versão no Spotify')).toBeNull();
  });

  it('opens the inline add area at the top of the list and focuses its input', () => {
    useStore.setState({ state: roomState([track('t1', 'A')]) });
    const add = <input aria-label="Buscar uma música" />;
    const { rerender } = render(<QueuePanel roomId="r1" canControl onAdd={() => {}} addOpen={false} addSlot={add} />);
    const area = document.getElementById('r4-add-inline')!;
    expect(area).toHaveAttribute('hidden');
    rerender(<QueuePanel roomId="r1" canControl onAdd={() => {}} addOpen addSlot={add} />);
    expect(area).not.toHaveAttribute('hidden');
    expect(screen.getByLabelText('Buscar uma música')).toHaveFocus();
    expect(screen.getByRole('button', { name: /Adicionar música/ })).toHaveAttribute('aria-expanded', 'true');
  });
});
