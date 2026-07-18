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
  radioEnabled: boolean;
  version: number;
  transport?: TransportState;
};

export type RoomStatePub = {
  type: 'room.state';
  state: RoomState;
};
