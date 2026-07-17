import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './realtime';
import type { RoomState } from '@cojam/shared';

const state = (version: number, roomId = 'r1'): RoomState => ({
  roomId,
  queue: [],
  radioEnabled: false,
  version,
});

describe('room store', () => {
  beforeEach(() => {
    useStore.setState({ state: null, connected: false, name: '' });
  });

  it('seeds from null (join result — regression: undefined seed bug)', () => {
    useStore.getState().setState(state(0));
    expect(useStore.getState().state?.roomId).toBe('r1');
    expect(useStore.getState().state?.version).toBe(0);
  });

  it('applies newer versions from publications', () => {
    useStore.getState().setState(state(1));
    useStore.getState().setState(state(2));
    expect(useStore.getState().state?.version).toBe(2);
  });

  it('drops stale/duplicate versions (out-of-order publication)', () => {
    useStore.getState().setState(state(5));
    useStore.getState().setState(state(3));
    expect(useStore.getState().state?.version).toBe(5);
    useStore.getState().setState(state(5));
    expect(useStore.getState().state?.version).toBe(5);
  });

  it('tracks connection + name', () => {
    useStore.getState().setConnected(true);
    useStore.getState().setName('Lucas');
    expect(useStore.getState().connected).toBe(true);
    expect(useStore.getState().name).toBe('Lucas');
  });
});
