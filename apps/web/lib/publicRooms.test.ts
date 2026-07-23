import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  listPublicRooms,
  subscribePublicRooms,
  __resetPublicRoomsForTests,
} from './publicRooms';
import type { PublicRoomSummary } from '@cojam/shared';

// Centrifuge/realtime mocks: the service client is recorded so tests can drive
// 'connected' and inspect RPCs; realtime supplies token + wsUrl resolution.
const centrifugeMock = vi.hoisted(() => {
  class MockCentrifuge {
    static instances: MockCentrifuge[] = [];
    handlers: Record<string, Array<() => void>> = {};
    rpcCalls: Array<{ method: string; payload: unknown }> = [];
    rpcResult: unknown = { rooms: [] };
    rpcError: unknown = null;
    disconnected = false;
    constructor(public url: string, public opts: Record<string, unknown>) {
      MockCentrifuge.instances.push(this);
    }
    on(event: string, cb: () => void) {
      (this.handlers[event] ??= []).push(cb);
      return this;
    }
    emit(event: string) {
      (this.handlers[event] ?? []).forEach((cb) => cb());
    }
    connect() { /* no-op: tests emit 'connected' manually */ }
    disconnect() {
      this.disconnected = true;
    }
    rpc(method: string, payload: unknown) {
      this.rpcCalls.push({ method, payload });
      if (this.rpcError) return Promise.reject(this.rpcError);
      return Promise.resolve({ data: this.rpcResult });
    }
  }
  return { MockCentrifuge };
});

vi.mock('centrifuge', () => ({ Centrifuge: centrifugeMock.MockCentrifuge }));

vi.mock('./realtime', () => ({
  resolveConnectionToken: vi.fn(async () => ''),
  resolveWsUrl: vi.fn(() => 'ws://test/connection/websocket'),
}));

const fixtures: PublicRoomSummary[] = [
  { roomId: 'NEON42', name: 'Neon Room', memberCount: 7, nowPlaying: { title: 'Instant Crush', artist: 'Daft Punk' } },
];

const lastInstance = async () => {
  await vi.waitFor(() => {
    expect(centrifugeMock.MockCentrifuge.instances.length).toBeGreaterThan(0);
  });
  const instances = centrifugeMock.MockCentrifuge.instances;
  return instances[instances.length - 1];
};

describe('publicRooms service connection', () => {
  beforeEach(() => {
    __resetPublicRoomsForTests();
    centrifugeMock.MockCentrifuge.instances = [];
  });

  afterEach(() => {
    __resetPublicRoomsForTests();
  });

  it('listPublicRooms returns the directory from room.list', async () => {
    const promise = listPublicRooms();
    const instance = await lastInstance();
    instance.rpcResult = { rooms: fixtures };
    instance.emit('connected');

    await expect(promise).resolves.toEqual(fixtures);
    expect(instance.rpcCalls).toEqual([{ method: 'room.list', payload: {} }]);
  });

  it('listPublicRooms returns [] on any RPC error (feature off, rate limited)', async () => {
    const promise = listPublicRooms();
    const instance = await lastInstance();
    instance.rpcError = { code: 400, message: 'too many requests, slow down' };
    instance.emit('connected');

    await expect(promise).resolves.toEqual([]);
  });

  it('listPublicRooms returns [] when the server never connects', async () => {
    vi.useFakeTimers();
    try {
      const promise = listPublicRooms();
      await vi.waitFor(() => {
        expect(centrifugeMock.MockCentrifuge.instances.length).toBeGreaterThan(0);
      });
      // Never emit 'connected': the connect timeout must degrade to [].
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(promise).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls on subscribe and every 15s while visible, and disconnects when the last subscriber leaves', async () => {
    vi.useFakeTimers();
    try {
      const received: PublicRoomSummary[][] = [];
      const unsubscribe = subscribePublicRooms((rooms) => received.push(rooms));

      // Seeded synchronously with the (empty) last good list.
      expect(received).toEqual([[]]);

      const instance = await lastInstance();
      instance.rpcResult = { rooms: fixtures };
      instance.emit('connected');

      await vi.waitFor(() => {
        expect(received[received.length - 1]).toEqual(fixtures);
      });
      expect(instance.rpcCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(instance.rpcCalls).toHaveLength(2);

      unsubscribe();
      expect(instance.disconnected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last good list when a poll fails', async () => {
    vi.useFakeTimers();
    try {
      const received: PublicRoomSummary[][] = [];
      subscribePublicRooms((rooms) => received.push(rooms));

      const instance = await lastInstance();
      instance.rpcResult = { rooms: fixtures };
      instance.emit('connected');
      await vi.waitFor(() => {
        expect(received[received.length - 1]).toEqual(fixtures);
      });

      // Next poll is rate limited: the listener must not be called with [].
      instance.rpcError = { code: 400, message: 'too many requests, slow down' };
      const callsBefore = received.length;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(received.length).toBe(callsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling while hidden and resumes on visible', async () => {
    vi.useFakeTimers();
    try {
      subscribePublicRooms(() => {});
      const instance = await lastInstance();
      instance.rpcResult = { rooms: fixtures };
      instance.emit('connected');
      await vi.waitFor(() => {
        expect(instance.rpcCalls.length).toBeGreaterThan(0);
      });

      // Hide the tab: the interval is cleared, so time passing polls nothing.
      const callsBefore = instance.rpcCalls.length;
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(45_000);
      expect(instance.rpcCalls.length).toBe(callsBefore);

      // Back to visible: an immediate poll fires plus the interval resumes.
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.waitFor(() => {
        expect(instance.rpcCalls.length).toBe(callsBefore + 1);
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(instance.rpcCalls.length).toBe(callsBefore + 2);
    } finally {
      vi.useRealTimers();
    }
  });
});
