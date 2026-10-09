import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { RoomState } from '@cojam/shared';
import { useStore, type Member } from '@/lib/realtime';
import { skipVotesNeeded } from '@/lib/skipVote';
import { SkipVoteButton } from './SkipVoteButton';

const rpc = vi.hoisted(() => ({ vote: vi.fn<(room: string, id: string, vote: boolean) => Promise<void>>(async () => {}) }));
vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  nowPlayingVoteSkip: rpc.vote,
}));

const members = (n: number): Member[] =>
  Array.from({ length: n }, (_, i) => ({ clientId: `c${i}`, name: `P${i}` }));

const state = (over: Partial<RoomState> = {}): RoomState => ({
  roomId: 'r1',
  queue: [{ id: 't1', title: 'T', artist: 'A', sources: {}, addedBy: 'x' }],
  nowPlayingId: 't1',
  radioEnabled: false,
  version: 1,
  ...over,
});

function setFlag(enabled: boolean) {
  window.__COJAM_ENV__ = { features: { queueVoting: enabled } };
}

describe('skipVotesNeeded', () => {
  it('matches the server table', () => {
    expect([1, 2, 3, 4, 5, 6].map(skipVotesNeeded)).toEqual([1, 2, 2, 2, 3, 3]);
    expect(skipVotesNeeded(0)).toBe(1);
  });
});

describe('SkipVoteButton', () => {
  beforeEach(() => {
    rpc.vote.mockClear();
    setFlag(true);
    useStore.setState({ state: state(), members: members(2), myVotes: {} });
  });
  afterEach(() => {
    delete window.__COJAM_ENV__;
  });

  it('shows the count against the threshold, unpressed', () => {
    useStore.setState({ state: state({ skipVotes: ['user:a'] }) });
    render(<SkipVoteButton roomId="r1" variant="palco" />);
    const btn = screen.getByRole('button', { name: /Pular/ });
    expect(btn).toHaveTextContent('Pular 1/2');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('votes, then shows pressed; a second press retracts', async () => {
    rpc.vote.mockImplementation(async (_room: string, id: string, vote: boolean) => {
      useStore.getState().markVoted(`skip:${id}`, vote);
    });
    render(<SkipVoteButton roomId="r1" variant="r4" />);
    fireEvent.click(screen.getByRole('button', { name: /Pular/ }));
    expect(rpc.vote).toHaveBeenLastCalledWith('r1', 't1', true);
    await waitFor(() => expect(screen.getByRole('button', { name: /Pular/ })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(screen.getByRole('button', { name: /Pular/ }));
    expect(rpc.vote).toHaveBeenLastCalledWith('r1', 't1', false);
    await waitFor(() => expect(screen.getByRole('button', { name: /Pular/ })).toHaveAttribute('aria-pressed', 'false'));
  });

  it('starts unpressed on the next track', () => {
    useStore.setState({ myVotes: { 'skip:t1': true } });
    const { rerender } = render(<SkipVoteButton roomId="r1" variant="palco" />);
    expect(screen.getByRole('button', { name: /Pular/ })).toHaveAttribute('aria-pressed', 'true');
    useStore.setState({ state: state({ nowPlayingId: 't2' }) });
    rerender(<SkipVoteButton roomId="r1" variant="palco" />);
    expect(screen.getByRole('button', { name: /Pular/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('is hidden when nothing plays', () => {
    useStore.setState({ state: state({ nowPlayingId: undefined }) });
    render(<SkipVoteButton roomId="r1" variant="palco" />);
    expect(screen.queryByRole('button', { name: /Pular/ })).toBeNull();
  });

  it('is hidden when voting is off', () => {
    setFlag(false);
    render(<SkipVoteButton roomId="r1" variant="palco" />);
    expect(screen.queryByRole('button', { name: /Pular/ })).toBeNull();
  });
});
