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
};

export type RoomStatePub = {
  type: 'room.state';
  state: RoomState;
};
