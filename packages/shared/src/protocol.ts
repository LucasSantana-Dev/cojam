export type SourceRef = {
  videoId?: string;
  songId?: string;
  confidence: number;
};

export type TrackRef = {
  id: string;
  title: string;
  artist: string;
  durationMs?: number;
  isrc?: string;
  sources: { youtube?: SourceRef; apple?: SourceRef };
  addedBy: string;
};

export type RoomState = {
  roomId: string;
  queue: TrackRef[];
  nowPlayingId?: string;
  version: number;
};

export type RoomStatePub = {
  type: 'room.state';
  state: RoomState;
};
