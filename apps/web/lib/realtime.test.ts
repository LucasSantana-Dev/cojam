import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, parseConnInfo, buildProviderPrefs, joinRoom } from './realtime';
import type { RoomState } from '@cojam/shared';

// Centrifuge/auth/account mocks for the joinRoom lifecycle tests (B9/B10/B11).
// The mock records instances so tests can drive 'connected' events and
// inspect the options and RPCs each instance received.
const centrifugeMock = vi.hoisted(() => {
  class MockSubscription {
    handlers: Record<string, Array<(ctx?: unknown) => void>> = {};
    on(event: string, cb: (ctx?: unknown) => void) {
      (this.handlers[event] ??= []).push(cb);
      return this;
    }
    subscribe() { /* no-op */ }
    presence() {
      return Promise.resolve({ clients: {} });
    }
  }
  class MockCentrifuge {
    static instances: MockCentrifuge[] = [];
    handlers: Record<string, Array<(ctx?: unknown) => void>> = {};
    rpcCalls: Array<{ method: string; payload: unknown }> = [];
    joinResponse: unknown = null;
    constructor(public url: string, public opts: Record<string, unknown>) {
      MockCentrifuge.instances.push(this);
    }
    on(event: string, cb: (ctx?: unknown) => void) {
      (this.handlers[event] ??= []).push(cb);
      return this;
    }
    emit(event: string, ctx?: unknown) {
      (this.handlers[event] ?? []).forEach((cb) => cb(ctx));
    }
    newSubscription() {
      return new MockSubscription();
    }
    connect() { /* no-op: tests emit 'connected' manually */ }
    rpc(method: string, payload: unknown) {
      this.rpcCalls.push({ method, payload });
      if (method === 'sync.ping') return Promise.resolve({ data: { serverNowMs: 0 } });
      if (method === 'room.join') return Promise.resolve({ data: this.joinResponse });
      return Promise.resolve({ data: null });
    }
  }
  return { MockCentrifuge };
});

vi.mock('centrifuge', () => ({ Centrifuge: centrifugeMock.MockCentrifuge }));

const authMocks = vi.hoisted(() => ({
  accountToken: null as string | null,
  fetchConnectionToken: vi.fn(async () => ({ token: 'anon-token' })),
}));
vi.mock('./account', () => ({
  getAccountToken: vi.fn(async () => authMocks.accountToken),
}));
vi.mock('./auth', () => ({
  fetchConnectionToken: authMocks.fetchConnectionToken,
}));

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

describe('buildProviderPrefs', () => {
  it('returns empty when nothing is connected', () => {
    expect(buildProviderPrefs({})).toEqual([]);
    expect(buildProviderPrefs({ spotify: false, apple: false })).toEqual([]);
  });

  it('lists spotify when spotify is connected', () => {
    expect(buildProviderPrefs({ spotify: true })).toEqual(['spotify']);
  });

  it('lists apple when apple is connected', () => {
    expect(buildProviderPrefs({ apple: true })).toEqual(['apple']);
  });

  it('lists both in canonical order when both are connected', () => {
    expect(buildProviderPrefs({ spotify: true, apple: true })).toEqual(['spotify', 'apple']);
  });
});

describe('joinRoom lifecycle (B9/B10/B11)', () => {
  beforeEach(() => {
    centrifugeMock.MockCentrifuge.instances = [];
    authMocks.accountToken = null;
    authMocks.fetchConnectionToken.mockClear();
    useStore.setState({ state: null, connected: false, reconnecting: false });
  });

  // joinRoom resolves the token (async) before constructing Centrifuge, so
  // the instance does not exist until microtasks flush.
  const lastInstance = async () => {
    await vi.waitFor(() => {
      expect(centrifugeMock.MockCentrifuge.instances.length).toBeGreaterThan(0);
    });
    const instances = centrifugeMock.MockCentrifuge.instances;
    return instances[instances.length - 1];
  };

  it('passes the account token as the initial token and wires getToken for refresh (B9)', async () => {
    authMocks.accountToken = 'sb-token';
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;

    expect(instance.opts.token).toBe('sb-token');
    expect(typeof instance.opts.getToken).toBe('function');
    await expect((instance.opts.getToken as () => Promise<string>)()).resolves.toBe('sb-token');
  });

  it('getToken refreshes via the anonymous room-auth token when no account token (B9)', async () => {
    // features.roomAuth is off in the test env, so the fallback is the empty
    // v0 token and fetchConnectionToken is not consulted.
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;

    expect(instance.opts.token).toBe('');
    await expect((instance.opts.getToken as () => Promise<string>)()).resolves.toBe('');
  });

  it('re-joins and adopts the authoritative state on reconnect (B10)', async () => {
    const instance0state = state(1, 'room-1');
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.joinResponse = instance0state;
    instance.emit('connected');
    await joinPromise;
    expect(useStore.getState().state?.version).toBe(1);

    // Simulate a drop + reconnect: the server is now at version 2.
    instance.joinResponse = state(2, 'room-1');
    instance.rpcCalls = [];
    instance.emit('connected');

    await vi.waitFor(() => {
      expect(instance.rpcCalls.some((c) => c.method === 'room.join')).toBe(true);
    });
    await vi.waitFor(() => {
      expect(useStore.getState().state?.version).toBe(2);
    });
  });

  it('does not double-join on the initial connect (B10)', async () => {
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;

    const joinCalls = instance.rpcCalls.filter((c) => c.method === 'room.join');
    expect(joinCalls).toHaveLength(1);
  });

  it('rejects when the server is unreachable instead of hanging forever (B11)', async () => {
    vi.useFakeTimers();
    try {
      const joinPromise = joinRoom('room-1', 'Alice');
      // Never emit 'connected': the timeout must fire.
      const assertion = expect(joinPromise).rejects.toThrow(/reach the server/);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizes a plain {code, message} room.join rejection into an Error (B11)', async () => {
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    instance.rpc = (method: string) => {
      if (method === 'room.join') return Promise.reject({ code: 403, message: 'room is full' });
      return Promise.resolve({ data: { serverNowMs: 0 } });
    };
    await expect(joinPromise).rejects.toThrow('room is full');
  });
});
