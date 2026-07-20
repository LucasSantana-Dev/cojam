import { create } from 'zustand';
import { Centrifuge } from 'centrifuge';
import { pickEnv, getRuntimeEnv } from './runtimeEnv';
import { estimateOffset, type PingSample } from './clockSync';
import { fetchConnectionToken } from './auth';
import { getAccountToken } from './account';
import { features } from './features';
import type { RoomState, RoomStatePub, TrackRef } from '@cojam/shared';

export type Member = { clientId: string; name: string; platform?: 'spotify' | 'apple' | 'youtube' };

export interface AppStore {
  state: RoomState | null;
  connected: boolean;
  reconnecting: boolean;
  name: string;
  members: Member[];
  connectedServices: string[];
  setName: (name: string) => void;
  setState: (state: RoomState) => void;
  setConnected: (connected: boolean) => void;
  setReconnecting: (reconnecting: boolean) => void;
  setMembers: (members: Member[]) => void;
  setConnectedServices: (services: string[]) => void;
  addMember: (m: Member) => void;
  removeMember: (clientId: string) => void;
}

export const useStore = create<AppStore>((set) => ({
  state: null,
  connected: false,
  reconnecting: false,
  name: '',
  members: [],
  connectedServices: [],
  setName: (name) => set({ name }),
  setState: (state) => set((s) => ({
    state: !s.state || state.version > s.state.version ? state : s.state,
  })),
  setConnected: (connected) => set({ connected }),
  setReconnecting: (reconnecting) => set({ reconnecting }),
  setMembers: (members) => set({ members }),
  setConnectedServices: (connectedServices) => set({ connectedServices }),
  addMember: (m) => set((s) =>
    s.members.some((x) => x.clientId === m.clientId) ? s : { members: [...s.members, m] }),
  removeMember: (clientId) => set((s) => ({ members: s.members.filter((x) => x.clientId !== clientId) })),
}));

// Presence entry info is the JSON {name, platform?} we set as ConnInfo server-side.
interface ConnInfo {
  name: string;
  platform?: 'spotify' | 'apple' | 'youtube';
}

export function parseConnInfo(info: unknown): { name: string; platform?: 'spotify' | 'apple' | 'youtube' } {
  const result: { name: string; platform?: 'spotify' | 'apple' | 'youtube' } = { name: 'Listener' };
  try {
    let parsed: unknown = info;
    if (parsed instanceof Uint8Array) {
      parsed = JSON.parse(new TextDecoder().decode(parsed));
    } else if (typeof parsed === 'string') {
      const raw = parsed;
      // Try to parse as JSON directly first (for test/direct use cases)
      try {
        parsed = JSON.parse(raw);
      } catch {
        // If that fails, try base64 decode then parse (for wire protocol)
        parsed = JSON.parse(atob(raw));
      }
    }

    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if ('name' in obj && typeof obj.name === 'string') {
        result.name = obj.name || 'Listener';
      }
      if ('platform' in obj && typeof obj.platform === 'string') {
        const p = obj.platform as string;
        if (p === 'spotify' || p === 'apple' || p === 'youtube') {
          result.platform = p;
        }
      }
    }
  } catch {
    /* fall through, use default */
  }
  return result;
}

function nameFromInfo(info: unknown, fallback = 'Listener'): string {
  return parseConnInfo(info).name || fallback;
}

let centrifuge: Centrifuge | null = null;

export async function joinRoom(
  roomId: string,
  name: string,
  platform?: 'spotify' | 'apple' | 'youtube' | null,
) {
  const wsUrl = pickEnv(
    getRuntimeEnv()?.wsUrl,
    process.env.NEXT_PUBLIC_WS_URL,
    'ws://localhost:8080/connection/websocket',
  );

  const connInfo: ConnInfo = { name };
  if (platform) connInfo.platform = platform;

  // Connection token precedence: a signed-in Supabase account token wins (the
  // server derives a stable "sb:<uuid>" identity from it); otherwise the
  // anonymous room-auth token; otherwise empty (v0 behavior).
  let token = '';
  const accountToken = await getAccountToken();
  if (accountToken) {
    token = accountToken;
  } else if (features.roomAuth) {
    const tokenResult = await fetchConnectionToken();
    if (tokenResult) {
      token = tokenResult.token;
    }
    // If fetch fails or feature is off, token remains empty (v0 behavior).
  }

  centrifuge = new Centrifuge(wsUrl, {
    token,
    data: connInfo, // becomes presence ConnInfo server-side
    // Read RPCs like track.lyrics (LRCLIB) and track.depth (MusicBrainz) hit
    // slow crowd-sourced upstreams; the server caps them at ~10s and returns a
    // graceful empty. The client must wait past that, so raise the default (5s).
    timeout: 12000,
  });

  const store = useStore.getState();
  store.setName(name);

  centrifuge.on('connected', () => {
    store.setConnected(true);
    store.setReconnecting(false);
    // Re-measure clock offset on reconnect (fire-and-forget, non-fatal on error)
    measureClockOffset().catch(() => {
      /* clock sync error - not fatal */
    });
  });

  centrifuge.on('connecting', () => {
    store.setReconnecting(true);
  });

  centrifuge.on('disconnected', () => {
    store.setConnected(false);
    store.setReconnecting(false);
  });

  const sub = centrifuge.newSubscription(`room:${roomId}`);

  sub.on('publication', (ctx) => {
    const pub = ctx.data as RoomStatePub;
    if (pub.type === 'room.state') {
      store.setState(pub.state);
    }
  });

  // Presence: seed the member list on subscribe, then track join/leave live.
  sub.on('subscribed', () => {
    sub.presence().then((res) => {
      const members: Member[] = Object.values(res.clients ?? {}).map((c) => {
        const info = parseConnInfo(c.connInfo);
        return {
          clientId: c.client,
          name: info.name,
          platform: info.platform,
        };
      });
      store.setMembers(members);
    }).catch(() => { /* presence unavailable — leave list empty */ });
  });
  sub.on('join', (ctx) => {
    const info = parseConnInfo(ctx.info.connInfo);
    store.addMember({ clientId: ctx.info.client, name: info.name, platform: info.platform });
  });
  sub.on('leave', (ctx) => {
    store.removeMember(ctx.info.client);
  });

  sub.subscribe();

  centrifuge.connect();

  await new Promise<void>((resolve) => {
    centrifuge!.on('connected', () => resolve());
  });

  // RPC result IS the RoomState (docs/protocol.md), not wrapped in {state}
  const joinResult = await centrifuge.rpc('room.join', { roomId, name });
  if (joinResult.data) {
    store.setState(joinResult.data as RoomState);
  }

  // Measure initial clock offset (fire-and-forget, non-fatal on error)
  measureClockOffset().catch(() => {
    /* clock sync error - not fatal */
  });

  return sub;
}

export async function queueAdd(roomId: string, track: Omit<TrackRef, 'id'>) {
  if (!centrifuge) throw new Error('Not connected');
  await centrifuge.rpc('queue.add', { roomId, track });
}

export async function queueRemove(roomId: string, trackId: string) {
  if (!centrifuge) throw new Error('Not connected');
  await centrifuge.rpc('queue.remove', { roomId, trackId });
}

export async function nowPlayingSet(roomId: string, trackId: string) {
  if (!centrifuge) throw new Error('Not connected');
  await centrifuge.rpc('now_playing.set', { roomId, trackId });
}

export async function nowPlayingAdvance(roomId: string, afterId: string) {
  if (!centrifuge) throw new Error('Not connected');
  await centrifuge.rpc('now_playing.advance', { roomId, afterId });
}

export async function queueReorder(roomId: string, trackId: string, toIndex: number) {
  if (!centrifuge) throw new Error('Not connected');
  await centrifuge.rpc('queue.reorder', { roomId, trackId, toIndex });
}

export async function importPlaylist(roomId: string, url: string, addedBy: string, tracks?: Omit<TrackRef, 'id' | 'addedBy'>[]) {
  if (!centrifuge) throw new Error('Not connected');
  try {
    // tracks is set for RFC-0007 client-side Spotify imports: the browser
    // already resolved the playlist with the user's OAuth token.
    await centrifuge.rpc('playlist.import', { roomId, url, addedBy, ...(tracks?.length ? { tracks } : {}) });
  } catch (err) {
    // centrifuge-js rejects with a plain {code, message} object, not an Error;
    // normalize so callers can show the server's message via err.message.
    const msg = (err as { message?: string })?.message;
    throw new Error(msg || 'Failed to import playlist');
  }
}

export async function setRadio(roomId: string, enabled: boolean) {
  if (!centrifuge) throw new Error('Not connected');
  await centrifuge.rpc('radio.set', { roomId, enabled });
}

export type SearchCandidate = {
  title: string;
  artist: string;
  source: string; // "spotify"|"deezer"
  spotifyUri?: string;
  isrc: string;
  durationMs: number;
  artworkUrl: string;
};

export type TrackDepthCredit = {
  role: string;
  name: string;
};

export type TrackDepth = {
  credits: TrackDepthCredit[];
  releaseYear?: number;
  label?: string;
  tags: string[];
  source: string; // "musicbrainz"
};

// buildProviderPrefs maps the caller's connected playback services to the provider
// list the server uses to rank track.search results (playable-on-your-service first).
// Canonical order matches pickSource: spotify before apple. Deezer is never listed:
// it is the anonymous fallback, not a connectable service.
export function buildProviderPrefs({ spotify, apple }: { spotify?: boolean; apple?: boolean }): string[] {
  const prefs: string[] = [];
  if (spotify) prefs.push('spotify');
  if (apple) prefs.push('apple');
  return prefs;
}

export async function searchTracks(query: string, prefer?: string[]): Promise<SearchCandidate[]> {
  if (!centrifuge) throw new Error('Not connected');
  const result = await centrifuge.rpc('track.search', { query, ...(prefer && prefer.length > 0 ? { prefer } : {}) });
  return (result.data as SearchCandidate[]) ?? [];
}

export async function fetchTrackDepth(roomId: string, isrc: string, title: string, artist: string): Promise<TrackDepth> {
  if (!centrifuge) throw new Error('Not connected');
  const result = await centrifuge.rpc('track.depth', { roomId, isrc, title, artist });
  return (result.data as TrackDepth) ?? { credits: [], tags: [], source: 'musicbrainz' };
}

export type LyricLine = {
  timeMs: number;
  text: string;
};

export type Lyrics = {
  synced: LyricLine[];
  plain: string;
  source: string; // "lrclib"
};

export async function fetchLyrics(roomId: string, artist: string, title: string, album?: string, durationMs?: number): Promise<Lyrics> {
  if (!centrifuge) throw new Error('Not connected');
  const result = await centrifuge.rpc('track.lyrics', { roomId, artist, title, album, durationMs });
  return (result.data as Lyrics) ?? { synced: [], plain: '', source: 'lrclib' };
}

export type ListenBrainzEnrichment = {
  mbid: string;
  tags: string[];
  count?: number;
  source: string; // "listenbrainz"
};

export async function fetchListenBrainz(roomId: string, isrc: string, title: string, artist: string): Promise<ListenBrainzEnrichment> {
  if (!centrifuge) throw new Error('Not connected');
  const result = await centrifuge.rpc('track.listenbrainz', { roomId, isrc, title, artist });
  return (result.data as ListenBrainzEnrichment) ?? { mbid: '', tags: [], source: 'listenbrainz' };
}

export type LastfmEnrich = {
  playcount: number;
  listeners: number;
  tags: string[];
  source: string; // "lastfm"
};

export async function fetchLastfmEnrich(roomId: string, artist: string, title: string): Promise<LastfmEnrich> {
  if (!centrifuge) throw new Error('Not connected');
  const result = await centrifuge.rpc('track.lastfm', { roomId, artist, title });
  return (result.data as LastfmEnrich) ?? { playcount: 0, listeners: 0, tags: [], source: 'lastfm' };
}

// Clock sync (U3): measure client-server time offset for synchronized playback

let clockOffsetMs = 0;

export async function syncPing(): Promise<number> {
  if (!centrifuge) throw new Error('Not connected');
  const result = await centrifuge.rpc('sync.ping', {});
  return (result.data as { serverNowMs: number }).serverNowMs;
}

export async function measureClockOffset(samples = 5): Promise<{ offsetMs: number; rttMs: number }> {
  const pingSamples: PingSample[] = [];

  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    const serverNowMs = await syncPing();
    const t1 = Date.now();
    pingSamples.push({ t0, serverNowMs, t1 });
  }

  const result = estimateOffset(pingSamples);
  clockOffsetMs = result.offsetMs;
  return result;
}

export function getClockOffsetMs(): number {
  return clockOffsetMs;
}

// Transport controls (U5)
export async function transportPlay(roomId: string, opts?: { trackId?: string; positionMs?: number }) {
  if (!centrifuge) throw new Error('Not connected');
  await centrifuge.rpc('transport.play', { roomId, ...opts });
}

export async function transportPause(roomId: string, positionMs: number) {
  if (!centrifuge) throw new Error('Not connected');
  await centrifuge.rpc('transport.pause', { roomId, positionMs });
}

export async function transportSeek(roomId: string, positionMs: number) {
  if (!centrifuge) throw new Error('Not connected');
  await centrifuge.rpc('transport.seek', { roomId, positionMs });
}
