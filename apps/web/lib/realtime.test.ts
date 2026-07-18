import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, parseConnInfo } from './realtime';
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

describe('parseConnInfo', () => {
  it('parses ConnInfo with name only', () => {
    const result = parseConnInfo(JSON.stringify({ name: 'Alice' }));
    expect(result.name).toBe('Alice');
    expect(result.platform).toBeUndefined();
  });

  it('parses ConnInfo with name and platform', () => {
    const result = parseConnInfo(JSON.stringify({ name: 'Bob', platform: 'spotify' }));
    expect(result.name).toBe('Bob');
    expect(result.platform).toBe('spotify');
  });

  it('parses all valid platforms', () => {
    expect(parseConnInfo(JSON.stringify({ name: 'A', platform: 'spotify' })).platform).toBe('spotify');
    expect(parseConnInfo(JSON.stringify({ name: 'B', platform: 'apple' })).platform).toBe('apple');
    expect(parseConnInfo(JSON.stringify({ name: 'C', platform: 'youtube' })).platform).toBe('youtube');
  });

  it('ignores invalid platform values', () => {
    const result = parseConnInfo(JSON.stringify({ name: 'Charlie', platform: 'tiktok' }));
    expect(result.name).toBe('Charlie');
    expect(result.platform).toBeUndefined();
  });

  it('uses fallback name for empty string name', () => {
    const result = parseConnInfo(JSON.stringify({ name: '', platform: 'spotify' }));
    expect(result.name).toBe('Listener');
    expect(result.platform).toBe('spotify');
  });

  it('returns default for malformed JSON', () => {
    const result = parseConnInfo('not json');
    expect(result.name).toBe('Listener');
    expect(result.platform).toBeUndefined();
  });

  it('handles Uint8Array encoded ConnInfo', () => {
    const json = JSON.stringify({ name: 'Dana', platform: 'apple' });
    const uint8 = new TextEncoder().encode(json);
    const result = parseConnInfo(uint8);
    expect(result.name).toBe('Dana');
    expect(result.platform).toBe('apple');
  });

  it('handles base64 encoded ConnInfo', () => {
    const json = JSON.stringify({ name: 'Eve', platform: 'youtube' });
    const b64 = btoa(json);
    const result = parseConnInfo(b64);
    expect(result.name).toBe('Eve');
    expect(result.platform).toBe('youtube');
  });

  it('handles null/undefined input', () => {
    expect(parseConnInfo(null).name).toBe('Listener');
    expect(parseConnInfo(undefined).name).toBe('Listener');
  });

  it('handles object input directly', () => {
    const result = parseConnInfo({ name: 'Frank', platform: 'spotify' });
    expect(result.name).toBe('Frank');
    expect(result.platform).toBe('spotify');
  });
});
