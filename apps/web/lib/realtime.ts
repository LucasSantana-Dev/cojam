import { create } from 'zustand';
import { Centrifuge } from 'centrifuge';
import type { RoomState, RoomStatePub, TrackRef } from '@cojam/shared';

export type Member = { clientId: string; name: string };

export interface AppStore {
  state: RoomState | null;
  connected: boolean;
  reconnecting: boolean;
  name: string;
  members: Member[];
  setName: (name: string) => void;
  setState: (state: RoomState) => void;
  setConnected: (connected: boolean) => void;
  setReconnecting: (reconnecting: boolean) => void;
  setMembers: (members: Member[]) => void;
  addMember: (m: Member) => void;
  removeMember: (clientId: string) => void;
}

export const useStore = create<AppStore>((set) => ({
  state: null,
  connected: false,
  reconnecting: false,
  name: '',
  members: [],
  setName: (name) => set({ name }),
  setState: (state) => set((s) => ({
    state: !s.state || state.version > s.state.version ? state : s.state,
  })),
  setConnected: (connected) => set({ connected }),
  setReconnecting: (reconnecting) => set({ reconnecting }),
  setMembers: (members) => set({ members }),
  addMember: (m) => set((s) =>
    s.members.some((x) => x.clientId === m.clientId) ? s : { members: [...s.members, m] }),
  removeMember: (clientId) => set((s) => ({ members: s.members.filter((x) => x.clientId !== clientId) })),
}));

// Presence entry info is the JSON {name} we set as ConnInfo server-side.
function nameFromInfo(info: unknown, fallback = 'Listener'): string {
  try {
    if (info instanceof Uint8Array) info = JSON.parse(new TextDecoder().decode(info));
    else if (typeof info === 'string') info = JSON.parse(atob(info));
    if (info && typeof info === 'object' && 'name' in info) return String((info as { name: string }).name) || fallback;
  } catch {
    /* fall through */
  }
  return fallback;
}

let centrifuge: Centrifuge | null = null;

export async function joinRoom(roomId: string, name: string) {
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8080/connection/websocket';

  centrifuge = new Centrifuge(wsUrl, {
    token: '',
    data: { name }, // becomes presence ConnInfo server-side
  });

  const store = useStore.getState();
  store.setName(name);

  centrifuge.on('connected', () => {
    store.setConnected(true);
    store.setReconnecting(false);
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
      const members: Member[] = Object.values(res.clients ?? {}).map((c) => ({
        clientId: c.client,
        name: nameFromInfo(c.connInfo),
      }));
      store.setMembers(members);
    }).catch(() => { /* presence unavailable — leave list empty */ });
  });
  sub.on('join', (ctx) => {
    store.addMember({ clientId: ctx.info.client, name: nameFromInfo(ctx.info.connInfo) });
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

export async function importPlaylist(roomId: string, url: string, addedBy: string) {
  if (!centrifuge) throw new Error('Not connected');
  await centrifuge.rpc('playlist.import', { roomId, url, addedBy });
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

export async function searchTracks(query: string): Promise<SearchCandidate[]> {
  if (!centrifuge) throw new Error('Not connected');
  const result = await centrifuge.rpc('track.search', { query });
  return (result.data as SearchCandidate[]) ?? [];
}

export async function fetchTrackDepth(roomId: string, isrc: string, title: string, artist: string): Promise<TrackDepth> {
  if (!centrifuge) throw new Error('Not connected');
  const result = await centrifuge.rpc('track.depth', { roomId, isrc, title, artist });
  return (result.data as TrackDepth) ?? { credits: [], tags: [], source: 'musicbrainz' };
}
