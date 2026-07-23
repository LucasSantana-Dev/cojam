export type SourceRef = {
  videoId?: string;
  songId?: string;
  trackUri?: string;
  confidence: number;
};

export type TrackRef = {
  id: string;
  title: string;
  artist: string;
  durationMs?: number;
  isrc?: string;
  sources: { youtube?: SourceRef; apple?: SourceRef; spotify?: SourceRef };
  addedBy: string;
  // Server-populated from the connection identity on queue.add/playlist.import;
  // clients never send this (the server overwrites it). Empty when room auth is off.
  addedByUserId?: string;
  // Server clock (unix ms) when the track entered the queue, server-stamped;
  // clients never send this (the server overwrites it). Absent on tracks
  // queued before this existed.
  addedAt?: number;
};

export type TransportState = {
  state: 'playing' | 'paused' | 'stopped';
  positionMs: number;
  updatedAtServerMs: number;
};

export type RoomState = {
  roomId: string;
  queue: TrackRef[];
  nowPlayingId?: string;
  hostUserId?: string;
  radioEnabled: boolean;
  version: number;
  transport?: TransportState;
  // Server clock (unix ms) at room creation, server-stamped. Absent on rooms
  // created before this existed.
  createdAt?: number;
  // trackId -> server-stamped voter keys ("user:<userID>" or
  // "client:<clientID>"); clients never send these (F4 queue voting).
  votes?: { [trackId: string]: string[] };
  // Host-set directory opt-in (FEATURE_PUBLIC_ROOMS); absent = private.
  public?: boolean;
  // Optional host-set room label shown in the public directory. Not to be
  // confused with the `name` param of room.join (a member's display name).
  name?: string;
};

// PublicRoomSummary is the directory view of a public room returned by
// room.list. Deliberately narrow: queue contents, host id, transport, and
// vote data stay room-channel-only.
export type PublicRoomSummary = {
  roomId: string;
  name?: string;          // present only if the host set one
  memberCount: number;    // connected members (join + subscribe enrollment)
  nowPlaying?: { title: string; artist: string };
};

export type RoomStatePub = {
  type: 'room.state';
  state: RoomState;
};

export type ChatMessage = {
  id: string;              // server-assigned uuid
  roomId: string;
  name: string;            // sender display name (client-supplied, capped; like TrackRef.addedBy)
  userId?: string;         // server-stamped connection identity; empty when room auth is off
  text: string;            // trimmed, 1..300 chars
  sentAtServerMs: number;  // server clock, like TransportState.updatedAtServerMs
};

// Chat rides the same room:<id> channel as room.state but is ephemeral: never
// in RoomState, never persisted, so no version guard applies (F8).
export type ChatMessagePub = {
  type: 'chat.message';
  message: ChatMessage;
};
