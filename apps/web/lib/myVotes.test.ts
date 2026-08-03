// jsdom env (default): sessionStorage exists here. realtime.test.ts runs in
// node for the Uint8Array realm issue, so the myVotes persistence tests (#188)
// live in this file.
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, restoreMyVotes } from './realtime';
import type { RoomState } from '@cojam/shared';

const state = (roomId: string): RoomState => ({
  roomId,
  queue: [],
  radioEnabled: false,
  version: 1,
});

describe('myVotes persistence (#188)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    useStore.setState({ state: null, myVotes: {} });
  });

  it('persists markVoted under the joined room key', () => {
    useStore.getState().setState(state('r1'));

    useStore.getState().markVoted('t1', true);
    expect(JSON.parse(sessionStorage.getItem('mj_room_votes:r1') ?? 'null')).toEqual({ t1: true });

    useStore.getState().markVoted('t1', false);
    expect(JSON.parse(sessionStorage.getItem('mj_room_votes:r1') ?? 'null')).toEqual({});
  });

  it('keeps votes for different rooms in separate keys', () => {
    sessionStorage.setItem('mj_room_votes:r1', JSON.stringify({ t1: true }));

    useStore.getState().setState(state('r2'));
    useStore.getState().markVoted('t9', true);

    expect(JSON.parse(sessionStorage.getItem('mj_room_votes:r1') ?? 'null')).toEqual({ t1: true });
    expect(JSON.parse(sessionStorage.getItem('mj_room_votes:r2') ?? 'null')).toEqual({ t9: true });
  });

  it('restores the pressed state on join after a reload', () => {
    sessionStorage.setItem('mj_room_votes:r1', JSON.stringify({ t2: true }));
    restoreMyVotes('r1');
    expect(useStore.getState().myVotes).toEqual({ t2: true });
  });

  it('restores empty when nothing is persisted or the data is corrupt', () => {
    useStore.setState({ myVotes: { t1: true } });

    restoreMyVotes('r1');
    expect(useStore.getState().myVotes).toEqual({});

    sessionStorage.setItem('mj_room_votes:r1', 'not json{');
    useStore.setState({ myVotes: { t1: true } });
    restoreMyVotes('r1');
    expect(useStore.getState().myVotes).toEqual({});
  });
});
