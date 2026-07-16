import { create } from 'zustand';
import { Centrifuge } from 'centrifuge';
import type { RoomState, RoomStatePub, TrackRef } from '@music-jam/shared';

export interface AppStore {
  state: RoomState | null;
  connected: boolean;
  name: string;
  setName: (name: string) => void;
  setState: (state: RoomState) => void;
  setConnected: (connected: boolean) => void;
}

export const useStore = create<AppStore>((set) => ({
  state: null,
  connected: false,
  name: '',
  setName: (name) => set({ name }),
  setState: (state) => set((s) => ({
    state: !s.state || state.version > s.state.version ? state : s.state,
  })),
  setConnected: (connected) => set({ connected }),
}));

let centrifuge: Centrifuge | null = null;

export async function joinRoom(roomId: string, name: string) {
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8080/connection/websocket';

  centrifuge = new Centrifuge(wsUrl, {
    token: '',
  });

  const store = useStore.getState();
  store.setName(name);

  centrifuge.on('connected', () => {
    store.setConnected(true);
  });

  centrifuge.on('disconnected', () => {
    store.setConnected(false);
  });

  const sub = centrifuge.newSubscription(`room:${roomId}`);

  sub.on('publication', (ctx) => {
    const pub = ctx.data as RoomStatePub;
    if (pub.type === 'room.state') {
      store.setState(pub.state);
    }
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
