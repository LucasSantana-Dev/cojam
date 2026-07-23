// Public room directory data (F1). The landing page has no room subscription
// and joinRoom is room-scoped, so this module keeps one shared, lazy
// "service" centrifuge connection (no room channel) used only for room.list.
//
// Failure posture: the directory is an enhancement, never a blocker. Every
// error path (feature off server-side, rate limited, unreachable server)
// degrades to an empty/unchanged list so the caller keeps rendering the static
// example-room mock.

import { Centrifuge } from 'centrifuge';
import type { PublicRoomSummary } from '@cojam/shared';
import { resolveConnectionToken, resolveWsUrl } from './realtime';

const POLL_INTERVAL_MS = 15_000;
// Bounded wait on connect so an unreachable server degrades to the mock
// instead of polling forever against a dead client.
const CONNECT_TIMEOUT_MS = 10_000;

let serviceClient: Centrifuge | null = null;
let connectPromise: Promise<Centrifuge> | null = null;

// getServiceClient connects (once) on first use. Concurrent callers share the
// in-flight attempt; a failed attempt clears itself so the next poll retries.
async function getServiceClient(): Promise<Centrifuge> {
  if (serviceClient) return serviceClient;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const token = await resolveConnectionToken();
    const client = new Centrifuge(resolveWsUrl(), {
      token,
      getToken: resolveConnectionToken,
    });
    client.connect();
    await Promise.race([
      new Promise<void>((resolve) => {
        client.on('connected', () => resolve());
      }),
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('connect timeout')), CONNECT_TIMEOUT_MS);
      }),
    ]);
    serviceClient = client;
    return client;
  })();

  try {
    return await connectPromise;
  } finally {
    connectPromise = null;
  }
}

// fetchPublicRooms returns null on any failure so the poller can keep the last
// good list (a rate-limited or offline poll must not blank the strip).
async function fetchPublicRooms(): Promise<PublicRoomSummary[] | null> {
  try {
    const client = await getServiceClient();
    const result = await client.rpc('room.list', {});
    return (result.data as { rooms?: PublicRoomSummary[] })?.rooms ?? [];
  } catch {
    return null;
  }
}

// listPublicRooms is the one-shot read: the directory, or [] on any error.
export async function listPublicRooms(): Promise<PublicRoomSummary[]> {
  return (await fetchPublicRooms()) ?? [];
}

type Listener = (rooms: PublicRoomSummary[]) => void;

const listeners = new Set<Listener>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastRooms: PublicRoomSummary[] = [];

async function poll() {
  const rooms = await fetchPublicRooms();
  if (rooms === null) return; // keep the last good list
  lastRooms = rooms;
  listeners.forEach((listener) => listener(rooms));
}

function startTimer() {
  if (pollTimer !== null) return;
  pollTimer = setInterval(() => {
    void poll();
  }, POLL_INTERVAL_MS);
}

function stopTimer() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Poll only while the tab is visible; a hidden tab stops polling entirely and
// re-polls immediately when it comes back.
function onVisibilityChange() {
  if (typeof document === 'undefined') return;
  if (document.visibilityState === 'visible') {
    void poll();
    startTimer();
  } else {
    stopTimer();
  }
}

// subscribePublicRooms registers a landing-page consumer. The first
// subscriber connects the service client and starts polling (immediately,
// then every 15s while visible); when the last subscriber goes away the timer
// stops and the service client disconnects. Returns the unsubscribe function.
export function subscribePublicRooms(listener: Listener): () => void {
  listeners.add(listener);
  listener(lastRooms); // seed synchronously (empty until the first poll lands)

  if (listeners.size === 1) {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
      if (document.visibilityState === 'visible') {
        void poll();
        startTimer();
      }
    } else {
      void poll();
      startTimer();
    }
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopTimer();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (serviceClient) {
        serviceClient.disconnect();
        serviceClient = null;
      }
    }
  };
}

// Test hook: reset subscribers, timers, the last good list, and the service
// client between tests.
export function __resetPublicRoomsForTests(): void {
  listeners.clear();
  stopTimer();
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
  lastRooms = [];
  if (serviceClient) {
    serviceClient.disconnect();
    serviceClient = null;
  }
  connectPromise = null;
}
