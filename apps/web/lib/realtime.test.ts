// @vitest-environment node
// Node env: under jsdom the Uint8Array/TextEncoder globals come from a
// different V8 realm, so parseConnInfo's `instanceof Uint8Array` check
// misclassifies jsdom-created buffers.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, parseConnInfo, buildProviderPrefs, joinRoom, retryConnection, rpcErrorMessage, setRoomPublic, deleteChatMessage, kickMember, DISCONNECT_CODE_KICKED } from './realtime';
import type { ChatMessage, RoomState } from '@cojam/shared';

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
    subscriptions: MockSubscription[] = [];
    rpcCalls: Array<{ method: string; payload: unknown }> = [];
    joinResponse: unknown = null;
    chatHistoryResponse: unknown = null;
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
      const sub = new MockSubscription();
      this.subscriptions.push(sub);
      return sub;
    }
    connect() { /* no-op: tests emit 'connected' manually */ }
    rpc(method: string, payload: unknown) {
      this.rpcCalls.push({ method, payload });
      if (method === 'sync.ping') return Promise.resolve({ data: { serverNowMs: 0 } });
      if (method === 'room.join') return Promise.resolve({ data: this.joinResponse });
      if (method === 'chat.history') return Promise.resolve({ data: this.chatHistoryResponse ?? { messages: [] } });
      return Promise.resolve({ data: null });
    }
  }
  return { MockCentrifuge };
});

vi.mock('centrifuge', () => ({ Centrifuge: centrifugeMock.MockCentrifuge }));

const authMocks = vi.hoisted(() => ({
  accountToken: null as string | null,
  session: null as { userId: string; email: string | null; accessToken: string } | null,
  fetchConnectionToken: vi.fn(async (): Promise<{ token: string } | null> => ({ token: 'anon-token' })),
  lastTokenFetchError: null as string | null,
  proofToken: null as string | null,
  cleared: false,
}));
vi.mock('./account', () => ({
  getAccountToken: vi.fn(async () => authMocks.accountToken),
  getAccountSession: vi.fn(async () => authMocks.session),
}));
vi.mock('./auth', () => ({
  fetchConnectionToken: authMocks.fetchConnectionToken,
  getLastTokenFetchError: () => authMocks.lastTokenFetchError,
  getStoredProofToken: () => authMocks.proofToken,
  clearStoredIdentity: () => { authMocks.cleared = true; },
}));

// Runtime-env mock so tests can flip runtime-resolved flags (F8 room chat)
// without a window.__COJAM_ENV__ global (node env has no window).
const runtimeEnvMocks = vi.hoisted(() => ({
  env: undefined as { features?: { roomChat?: boolean; roomAuth?: boolean } } | undefined,
}));
vi.mock('./runtimeEnv', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runtimeEnv')>()),
  getRuntimeEnv: () => runtimeEnvMocks.env,
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

describe('chat store (F8)', () => {
  const chatMsg = (id: string): ChatMessage => ({
    id,
    roomId: 'r1',
    name: 'Ana',
    text: `msg ${id}`,
    sentAtServerMs: 1,
  });

  beforeEach(() => {
    useStore.setState({ chat: [] });
  });

  it('appends live messages and dedupes by id', () => {
    useStore.getState().addChatMessage(chatMsg('a'));
    useStore.getState().addChatMessage(chatMsg('b'));
    // A history refetch overlapping the live publication must not duplicate.
    useStore.getState().addChatMessage(chatMsg('a'));
    expect(useStore.getState().chat.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('caps the client scrollback at 100, dropping oldest', () => {
    for (let i = 0; i < 105; i++) {
      useStore.getState().addChatMessage(chatMsg(`m${i}`));
    }
    const chat = useStore.getState().chat;
    expect(chat).toHaveLength(100);
    expect(chat[0].id).toBe('m5');
    expect(chat[chat.length - 1].id).toBe('m104');
  });

  it('setChat replaces the list (join/rejoin seed)', () => {
    useStore.getState().addChatMessage(chatMsg('live'));
    useStore.getState().setChat([chatMsg('h1'), chatMsg('h2')]);
    expect(useStore.getState().chat.map((m) => m.id)).toEqual(['h1', 'h2']);
  });

  it('removeChatMessage drops the line by id (chat.delete tombstone, #181)', () => {
    useStore.getState().setChat([chatMsg('a'), chatMsg('b'), chatMsg('c')]);
    useStore.getState().removeChatMessage('b');
    expect(useStore.getState().chat.map((m) => m.id)).toEqual(['a', 'c']);
  });

  it('addChatMessage never adds a tombstoned line (#181)', () => {
    useStore.getState().addChatMessage({ ...chatMsg('t1'), deleted: true, text: '' });
    expect(useStore.getState().chat).toEqual([]);
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
    authMocks.session = null;
    authMocks.proofToken = null;
    authMocks.cleared = false;
    authMocks.lastTokenFetchError = null;
    authMocks.fetchConnectionToken.mockClear();
    runtimeEnvMocks.env = undefined;
    useStore.setState({ state: null, connected: false, reconnecting: false, chat: [], rebindNotice: null });
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

  it('rejects as unreachable when the transport fails instead of hanging forever (B11, #190)', async () => {
    vi.useFakeTimers();
    try {
      const joinPromise = joinRoom('room-1', 'Alice');
      // Flush the async token resolution so the instance exists, then fail the transport.
      await vi.advanceTimersByTimeAsync(0);
      const instance = centrifugeMock.MockCentrifuge.instances.at(-1)!;
      instance.emit('error', { type: 'transport', error: { code: 4, message: 'transport closed' } });
      // Never emit 'connected': the timeout must fire with the unreachable state.
      const assertion = expect(joinPromise).rejects.toThrow(/reach the server/);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects with a distinct timeout state when no connection failure is observed (#190)', async () => {
    vi.useFakeTimers();
    try {
      const joinPromise = joinRoom('room-1', 'Alice');
      // No transport error and no 'connected': a pure timeout, not "unreachable".
      const assertion = expect(joinPromise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects with a session-token state when the token fetch fails while room auth is on (#190)', async () => {
    runtimeEnvMocks.env = { features: { roomAuth: true } };
    authMocks.fetchConnectionToken.mockResolvedValueOnce(null);
    authMocks.lastTokenFetchError = 'HTTP 500';

    await expect(joinRoom('room-1', 'Alice')).rejects.toThrow(/session token/);
    // Fail fast: no connection is attempted against a token we know is missing.
    expect(centrifugeMock.MockCentrifuge.instances).toHaveLength(0);
  });

  it('still joins anonymously when the token endpoint is 501 (feature off) while room auth is on (#190)', async () => {
    runtimeEnvMocks.env = { features: { roomAuth: true } };
    authMocks.fetchConnectionToken.mockResolvedValueOnce(null);
    // 501 records no fetch error: the anonymous fallback is legitimate.
    authMocks.lastTokenFetchError = null;

    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;

    expect(instance.opts.token).toBe('');
  });

  it('rejects as unauthorized when the server rejects the connect (code 103) without waiting for the timeout (#190)', async () => {
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('disconnected', { code: 103, reason: 'unauthorized' });
    await expect(joinPromise).rejects.toThrow(/unauthorized/);
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

  it('retryConnection re-establishes the connection and resyncs state (#187)', async () => {
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;

    // Terminal disconnect: centrifuge stops retrying (e.g. rejected token).
    instance.emit('disconnected');
    expect(useStore.getState().connected).toBe(false);

    const retryPromise = retryConnection();
    await vi.waitFor(() => {
      expect(centrifugeMock.MockCentrifuge.instances.length).toBe(2);
    });
    const instance2 = centrifugeMock.MockCentrifuge.instances[1];
    expect(instance2).not.toBe(instance);
    instance2.joinResponse = state(2, 'room-1');
    instance2.emit('connected');
    await retryPromise;

    expect(useStore.getState().connected).toBe(true);
    expect(instance2.rpcCalls.some((c) => c.method === 'room.join')).toBe(true);
    expect(useStore.getState().state?.version).toBe(2);
  });

  it('setRoomPublic sends room.set_public with the right payload', async () => {
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;

    // Filter by method: the fire-and-forget clock sync (sync.ping) interleaves
    // with these calls, so position-based assertions would race.
    const setPublicCalls = () => instance.rpcCalls.filter((c) => c.method === 'room.set_public');

    await setRoomPublic('room-1', true, 'Neon Room');
    expect(setPublicCalls().at(-1)?.payload).toEqual({ roomId: 'room-1', public: true, name: 'Neon Room' });

    // name omitted: the key is absent so the server leaves the label untouched.
    await setRoomPublic('room-1', false);
    expect(setPublicCalls().at(-1)?.payload).toEqual({ roomId: 'room-1', public: false });

    // Empty string is sent (not omitted): empty after trim clears the label.
    await setRoomPublic('room-1', true, '');
    expect(setPublicCalls().at(-1)?.payload).toEqual({ roomId: 'room-1', public: true, name: '' });
  });
});

describe('room chat (F8)', () => {
  const chatMsg = (id: string, roomId = 'room-1'): ChatMessage => ({
    id,
    roomId,
    name: 'Bob',
    text: `text ${id}`,
    sentAtServerMs: 1,
  });

  beforeEach(() => {
    centrifugeMock.MockCentrifuge.instances = [];
    authMocks.accountToken = null;
    runtimeEnvMocks.env = undefined;
    useStore.setState({ state: null, connected: false, reconnecting: false, chat: [] });
  });

  const lastInstance = async () => {
    await vi.waitFor(() => {
      expect(centrifugeMock.MockCentrifuge.instances.length).toBeGreaterThan(0);
    });
    const instances = centrifugeMock.MockCentrifuge.instances;
    return instances[instances.length - 1];
  };

  it('routes chat.message publications to the chat store, room.state to setState', async () => {
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;

    const pubHandler = instance.subscriptions[0].handlers['publication'][0];
    pubHandler({ data: { type: 'room.state', state: state(3, 'room-1') } });
    expect(useStore.getState().state?.version).toBe(3);
    // A state publication must not touch chat, and vice versa.
    expect(useStore.getState().chat).toEqual([]);

    pubHandler({ data: { type: 'chat.message', message: chatMsg('m1') } });
    expect(useStore.getState().chat.map((m) => m.id)).toEqual(['m1']);
    expect(useStore.getState().state?.version).toBe(3);
  });

  it('fetches chat history after join when the flag is on', async () => {
    runtimeEnvMocks.env = { features: { roomChat: true } };
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.chatHistoryResponse = { messages: [chatMsg('h1'), chatMsg('h2')] };
    instance.emit('connected');
    await joinPromise;

    await vi.waitFor(() => {
      expect(useStore.getState().chat.map((m) => m.id)).toEqual(['h1', 'h2']);
    });
    expect(instance.rpcCalls.some((c) => c.method === 'chat.history')).toBe(true);
  });

  it('does not call chat.history when the flag is off', async () => {
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;

    expect(instance.rpcCalls.some((c) => c.method === 'chat.history')).toBe(false);
  });

  it('refetches chat history on reconnect, healing lines missed during the drop', async () => {
    runtimeEnvMocks.env = { features: { roomChat: true } };
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;

    // Live message arrives, then the connection drops with one missed line.
    const pubHandler = instance.subscriptions[0].handlers['publication'][0];
    pubHandler({ data: { type: 'chat.message', message: chatMsg('live1') } });
    instance.chatHistoryResponse = { messages: [chatMsg('live1'), chatMsg('missed2')] };

    instance.emit('connected');
    await vi.waitFor(() => {
      expect(useStore.getState().chat.map((m) => m.id)).toEqual(['live1', 'missed2']);
    });
  });

  it('routes chat.delete publications to the chat store (#181)', async () => {
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;

    const pubHandler = instance.subscriptions[0].handlers['publication'][0];
    pubHandler({ data: { type: 'chat.message', message: chatMsg('m1') } });
    pubHandler({ data: { type: 'chat.message', message: chatMsg('m2') } });
    expect(useStore.getState().chat.map((m) => m.id)).toEqual(['m1', 'm2']);

    pubHandler({ data: { type: 'chat.delete', messageId: 'm1' } });
    expect(useStore.getState().chat.map((m) => m.id)).toEqual(['m2']);
  });

  it('filters tombstoned lines out of the history seed (#181)', async () => {
    runtimeEnvMocks.env = { features: { roomChat: true } };
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.chatHistoryResponse = {
      messages: [chatMsg('h1'), { ...chatMsg('dead'), deleted: true, text: '' }, chatMsg('h2')],
    };
    instance.emit('connected');
    await joinPromise;

    await vi.waitFor(() => {
      expect(useStore.getState().chat.map((m) => m.id)).toEqual(['h1', 'h2']);
    });
  });
});

describe('rpcErrorMessage', () => {
  it('returns the message from a real Error', () => {
    expect(rpcErrorMessage(new Error('boom'), 'fallback')).toBe('boom');
  });

  it('unwraps centrifuge-style plain {code, message} rejections', () => {
    expect(rpcErrorMessage({ code: 403, message: 'not the host' }, 'fallback')).toBe('not the host');
  });

  it('falls back when there is no usable message', () => {
    expect(rpcErrorMessage({}, 'fallback')).toBe('fallback');
    expect(rpcErrorMessage(null, 'fallback')).toBe('fallback');
    expect(rpcErrorMessage(undefined, 'fallback')).toBe('fallback');
    expect(rpcErrorMessage('string rejection', 'fallback')).toBe('fallback');
    expect(rpcErrorMessage({ message: '' }, 'fallback')).toBe('fallback');
    expect(rpcErrorMessage(new Error(''), 'fallback')).toBe('fallback');
  });
});

describe('host moderation (#181)', () => {
  beforeEach(() => {
    centrifugeMock.MockCentrifuge.instances = [];
    authMocks.accountToken = null;
    runtimeEnvMocks.env = undefined;
    useStore.setState({ state: null, connected: false, reconnecting: false, chat: [], kicked: false, clientId: '' });
  });

  const lastInstance = async () => {
    await vi.waitFor(() => {
      expect(centrifugeMock.MockCentrifuge.instances.length).toBeGreaterThan(0);
    });
    const instances = centrifugeMock.MockCentrifuge.instances;
    return instances[instances.length - 1];
  };

  it('marks the store kicked when the server disconnects with the kicked code', async () => {
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;
    expect(useStore.getState().kicked).toBe(false);

    instance.emit('disconnected', { code: DISCONNECT_CODE_KICKED, reason: 'removed by host' });
    expect(useStore.getState().kicked).toBe(true);
    expect(useStore.getState().connected).toBe(false);
  });

  it('does not mark kicked for ordinary disconnects', async () => {
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;

    instance.emit('disconnected', { code: 3000, reason: 'connection closed' });
    expect(useStore.getState().kicked).toBe(false);
  });

  it('resets kicked on a fresh joinRoom', async () => {
    useStore.setState({ kicked: true });
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;
    expect(useStore.getState().kicked).toBe(false);
  });

  it('records the server-assigned client id on connect', async () => {
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected', { client: 'srv-client-1', transport: 'websocket' });
    await joinPromise;
    expect(useStore.getState().clientId).toBe('srv-client-1');
  });

  it('sends chat.delete and room.kick with the right payloads', async () => {
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;

    // Filter by method: the fire-and-forget clock sync (sync.ping) interleaves
    // with these calls, so position-based assertions would race.
    const callsFor = (method: string) => instance.rpcCalls.filter((c) => c.method === method);

    await deleteChatMessage('room-1', 'msg-9');
    expect(callsFor('chat.delete').at(-1)?.payload).toEqual({ roomId: 'room-1', messageId: 'msg-9' });

    await kickMember('room-1', 'client-7');
    expect(callsFor('room.kick').at(-1)?.payload).toEqual({ roomId: 'room-1', clientId: 'client-7' });
  });
});

describe('guest-to-account rebind (#172)', () => {
  beforeEach(() => {
    centrifugeMock.MockCentrifuge.instances = [];
    authMocks.accountToken = null;
    authMocks.session = null;
    authMocks.proofToken = null;
    authMocks.cleared = false;
    authMocks.lastTokenFetchError = null;
    runtimeEnvMocks.env = { features: { roomAuth: true } };
    useStore.setState({ state: null, connected: false, reconnecting: false, chat: [], rebindNotice: null });
  });

  const lastInstance = async () => {
    await vi.waitFor(() => {
      expect(centrifugeMock.MockCentrifuge.instances.length).toBeGreaterThan(0);
    });
    const instances = centrifugeMock.MockCentrifuge.instances;
    return instances[instances.length - 1];
  };

  const signIn = () => {
    authMocks.session = { userId: 'u1', email: null, accessToken: 'sb-token' };
    authMocks.accountToken = 'sb-token';
  };

  const rebindCalls = (instance: InstanceType<typeof centrifugeMock.MockCentrifuge>) =>
    instance.rpcCalls.filter((c) => c.method === 'room.rebind');

  // Reject room.rebind with the given server message; every other method
  // keeps the default mock behavior.
  const failRebindWith = (
    instance: InstanceType<typeof centrifugeMock.MockCentrifuge>,
    message: string,
  ) => {
    const defaultRpc = instance.rpc.bind(instance);
    instance.rpc = (method: string, payload: unknown) => {
      if (method === 'room.rebind') {
        instance.rpcCalls.push({ method, payload });
        return Promise.reject({ code: 400, message });
      }
      return defaultRpc(method, payload);
    };
  };

  it('attempts the rebind on room join with exactly {roomId, proof}, no identity field', async () => {
    signIn();
    authMocks.proofToken = 'proof-jwt';
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;

    await vi.waitFor(() => expect(rebindCalls(instance)).toHaveLength(1));
    const payload = rebindCalls(instance)[0].payload as Record<string, unknown>;
    expect(payload).toEqual({ roomId: 'room-1', proof: 'proof-jwt' });
    expect(Object.keys(payload).sort()).toEqual(['proof', 'roomId']);
  });

  it('does not attempt the rebind without a stored proof token', async () => {
    signIn();
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;
    await new Promise((r) => setTimeout(r, 10));
    expect(rebindCalls(instance)).toHaveLength(0);
  });

  it('does not attempt the rebind when signed out', async () => {
    authMocks.proofToken = 'proof-jwt';
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;
    await new Promise((r) => setTimeout(r, 10));
    expect(rebindCalls(instance)).toHaveLength(0);
  });

  it('keeps the proof token on RPC 200 alone, discards it when the publication shows the account identity', async () => {
    signIn();
    authMocks.proofToken = 'proof-jwt';
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;

    await vi.waitFor(() => expect(rebindCalls(instance)).toHaveLength(1));
    // The RPC resolved (mock 200) but no publication arrived yet: the token
    // must survive (publish can fail after commit, #178).
    await new Promise((r) => setTimeout(r, 10));
    expect(authMocks.cleared).toBe(false);

    const pubHandler = instance.subscriptions[0].handlers['publication'][0];
    pubHandler({
      data: {
        type: 'room.state',
        state: {
          roomId: 'room-1',
          queue: [
            { id: 't1', title: 'T', artist: 'A', sources: {}, addedBy: 'Alice', addedByUserId: 'sb:u1' },
          ],
          radioEnabled: false,
          version: 2,
        },
      },
    });
    await vi.waitFor(() => expect(authMocks.cleared).toBe(true));
  });

  it('keeps the proof token when the post-rebind publication does not show the account identity', async () => {
    signIn();
    authMocks.proofToken = 'proof-jwt';
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    instance.emit('connected');
    await joinPromise;

    await vi.waitFor(() => expect(rebindCalls(instance)).toHaveLength(1));
    const pubHandler = instance.subscriptions[0].handlers['publication'][0];
    pubHandler({
      data: {
        type: 'room.state',
        state: { roomId: 'room-1', queue: [], radioEnabled: false, version: 2 },
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(authMocks.cleared).toBe(false);
  });

  it('discards an unverifiable proof and shows the soft notice; sign-in proceeds', async () => {
    signIn();
    authMocks.proofToken = 'proof-jwt';
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    failRebindWith(instance, 'guest proof could not be verified');
    instance.emit('connected');
    await joinPromise; // the join itself never hard-fails on the rebind path

    await vi.waitFor(() => expect(authMocks.cleared).toBe(true));
    expect(useStore.getState().rebindNotice).toBe("Your earlier guest contributions couldn't be linked.");
  });

  it('discards an already-consumed proof silently (dead-token path)', async () => {
    signIn();
    authMocks.proofToken = 'proof-jwt';
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    failRebindWith(instance, 'this guest identity was already upgraded');
    instance.emit('connected');
    await joinPromise;

    await vi.waitFor(() => expect(authMocks.cleared).toBe(true));
    expect(useStore.getState().rebindNotice).toBeNull();
  });

  it('keeps the proof token on a transient failure so the next join retries', async () => {
    signIn();
    authMocks.proofToken = 'proof-jwt';
    const joinPromise = joinRoom('room-1', 'Alice');
    const instance = await lastInstance();
    failRebindWith(instance, 'could not load the room, please retry');
    instance.emit('connected');
    await joinPromise;

    await vi.waitFor(() => expect(rebindCalls(instance)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(authMocks.cleared).toBe(false);
    expect(useStore.getState().rebindNotice).toBeNull();
  });
});
