export type SourceRef = {
  videoId?: string;
  trackUri?: string;
  confidence: number;
};

export type TrackRef = {
  id: string;
  title: string;
  artist: string;
  durationMs?: number;
  isrc?: string;
  sources: { youtube?: SourceRef; spotify?: SourceRef };
  // Display-name attribution. Server-stamped from the connection's
  // connect-time name on queue.add/playlist.import when one was recorded
  // (client-supplied values are overridden then); client-supplied otherwise.
  addedBy: string;
  // Album/track artwork URL, client-supplied at queue.add/playlist.import time
  // from the search/playlist provider response (server validates https + length).
  // Absent on manual adds and tracks queued before this existed; clients render
  // a fallback tile (or derive a YouTube thumb from sources.youtube.videoId).
  artworkUrl?: string;
  // Whether clients should render this as audio or as video (#258). Absent
  // means audio, so existing queues and older clients are unaffected.
  kind?: 'audio' | 'video';
  // Server-populated from the connection identity on queue.add/playlist.import;
  // clients never send this (the server overwrites it). Empty when room auth is off.
  addedByUserId?: string;
  // Server clock (unix ms) when the track entered the queue, server-stamped;
  // clients never send this (the server overwrites it). Absent on tracks
  // queued before this existed.
  addedAt?: number;
};

// A track that finished or was skipped. Lives in RoomState.history, never in
// the queue, so votes and reorders cannot bring it back. The list uses id,
// title, artist, artworkUrl, playedAt and addedBy; sources (and durationMs,
// isrc, kind) are kept so a controller can re-add it (history.readd).
export type HistoryEntry = {
  id: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  addedBy: string;
  addedByUserId?: string;
  // Server clock (unix ms) when the track left now-playing. Absent on entries
  // migrated from rooms that predate history.
  playedAt?: number;
  durationMs?: number;
  isrc?: string;
  kind?: 'audio' | 'video';
  sources: { youtube?: SourceRef; spotify?: SourceRef };
};

export type TransportState = {
  state: 'playing' | 'paused' | 'stopped';
  positionMs: number;
  updatedAtServerMs: number;
};

export type RoomState = {
  roomId: string;
  // The playing track (head) plus the upcoming ones. Played tracks are in
  // `history`, not here.
  queue: TrackRef[];
  nowPlayingId?: string;
  // Tracks already played or skipped, newest first, at most 50. Absent when
  // empty. Votes and reorders never touch it.
  history?: HistoryEntry[];
  hostUserId?: string;
  // Room creator (server-set at creation). Always reclaims host on join and
  // cannot be demoted or kicked. Absent on rooms that predate it.
  ownerUserId?: string;
  // userIDs granted full queue and transport control by the host or owner.
  admins?: string[];
  radioEnabled: boolean;
  // Server capability (not room state, never persisted): true when the server
  // can actually refill a radio queue (FEATURE_RADIO + a Last.fm key). When
  // false, hide or disable the radio toggle. Absent on servers that predate it.
  radioAvailable?: boolean;
  // Server condition (not room state, never persisted): unix ms until which the
  // server's daily YouTube search quota is spent, so new tracks get no YouTube
  // source. Absent when searches work. Show a notice to YouTube listeners and
  // compute the local reset hour in the browser.
  youtubeQuotaUntil?: number;
  version: number;
  transport?: TransportState;
  // Server clock (unix ms) at room creation, server-stamped. Absent on rooms
  // created before this existed.
  createdAt?: number;
  // trackId -> server-stamped voter keys ("user:<userID>" or
  // "client:<clientID>"); clients never send these (F4 queue voting).
  votes?: { [trackId: string]: string[] };
  // Voter keys (same format as `votes`) who want the playing track skipped
  // (now_playing.vote_skip). Belongs to the current nowPlayingId only: the
  // server clears it on every track change. Absent when nobody voted.
  skipVotes?: string[];
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
  kind: 'audio' | 'video'; // now-playing track kind; audio when nothing plays
  lastActiveMs: number;    // room's last activity, unix ms (server clock)
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
  text: string;            // trimmed, 1..300 chars; redacted ("") once deleted
  // 'system' marks a server-generated announcement (#205: track change on
  // now_playing.advance, member join/leave) — rendered distinctly, carries no
  // member identity. Absent on user messages.
  kind?: 'system';
  sentAtServerMs: number;  // server clock, like TransportState.updatedAtServerMs
  // Tombstone set by chat.delete (host moderation, #181): the ring slot is
  // kept (history is never rewritten) but clients must not render the entry.
  deleted?: boolean;
};

// Chat rides the same room:<id> channel as room.state but is ephemeral: never
// in RoomState, never persisted, so no version guard applies (F8).
export type ChatMessagePub = {
  type: 'chat.message';
  message: ChatMessage;
};

// ChatDeletePub tells connected clients a message was tombstoned by the host
// (chat.delete, #181); clients drop it from their local list by id.
export type ChatDeletePub = {
  type: 'chat.delete';
  messageId: string;
};

// MemberPlatformPub: a member changed the service they listen through
// (member.set_platform). Clients overlay it on the presence entry with this
// clientId; not RoomState, no version guard.
export type MemberPlatformPub = {
  type: 'member.platform';
  clientId: string;
  platform: 'spotify' | 'youtube';
};

// Audience characters ("Modo palco"): a fixed roster of 14, ids 1..14, repeats
// allowed. The id is the whole payload: never an image or a free string.
export const CHARACTER_COUNT = 14;

// Default pool: a member who never chose gets 1 + (FNV-1a mod this). Pinned at
// 12 so nobody's default changed when character 13 joined the roster; 13 is
// pickable but never a default. Server twin: hub.DefaultCharacterPool.
export const CHARACTER_DEFAULT_POOL = 12;

export type CharacterId = number; // integer, 1..CHARACTER_COUNT

// MemberCharacterPub: a member picked another character (member.set_character).
// Clients overlay it on the presence entry with this clientId; not RoomState, no
// version guard. A member who never chose is shown with defaultCharacter(userId)
// (FNV-1a 32 bit of the userId bytes, mod 12, plus 1), identical on server and web.
export type MemberCharacterPub = {
  type: 'member.character';
  clientId: string;
  characterId: CharacterId;
};

// ReactionWootPub: a member pressed Curtir on the playing track (reaction.woot).
// Ephemeral room broadcast: not RoomState, never stored, no version guard. Only
// the connection is named; clients resolve it to a member through presence.
export type ReactionWootPub = {
  type: 'reaction.woot';
  clientId: string;
};

// The emotes of the Reagir bar (reaction.emote); the server rejects any other.
export const EMOTES = ['amei', 'fogo', 'rindo', 'palmas', 'uau', 'cantando'] as const;
export type Emote = (typeof EMOTES)[number];

// ReactionEmotePub: a member sent an emote (reaction.emote). Same contract as
// ReactionWootPub: ephemeral, not RoomState, the connection named only.
export type ReactionEmotePub = {
  type: 'reaction.emote';
  clientId: string;
  emote: Emote;
};
