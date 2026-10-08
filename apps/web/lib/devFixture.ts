// Dev-only deterministic room for screenshots and visual review against the
// approved mockup. Never active in a production build: fixtureKind() returns
// null when NODE_ENV is "production", so the branch is dead code there.
//   /room/<ID>?fixture=room  joined room (Pétala, 5 listeners, 4 queued, 3 chat lines)
//     members get characters (Modo palco); extras use the userId default
//     add &members=1|2|5|8 and &long=1 for long names (stage review)
//   /room/<ID>?fixture=join  pre-join screen with the room preview
import { useStore, type Member } from './realtime';
import { getStoredUserId } from './auth';
import type { IPlayer } from './playerInterface';
import type { ChatMessage, RoomState, TrackRef } from '@cojam/shared';

const USER_ID_KEY = 'cojam_uid';

export type FixtureKind = 'room' | 'join';

export function fixtureKind(): FixtureKind | null {
  if (process.env.NODE_ENV === 'production') return null;
  if (typeof window === 'undefined') return null;
  const k = new URLSearchParams(window.location.search).get('fixture');
  return k === 'room' || k === 'join' ? k : null;
}

// A loud abstract cover as a data URI, so the fixture needs no network.
function cover(a: string, b: string, c: string, d: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="${d}"/>` +
    `<circle cx="50" cy="55" r="70" fill="${a}"/><circle cx="160" cy="45" r="60" fill="${b}"/>` +
    `<circle cx="70" cy="165" r="65" fill="${c}"/><circle cx="165" cy="150" r="50" fill="${a}"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const NOW = () => Date.now();

function track(id: string, title: string, artist: string, addedBy: string, art: string, durationMs = 214000): TrackRef {
  return { id, title, artist, durationMs, addedBy, artworkUrl: art, sources: { youtube: { videoId: `fx${id}`, confidence: 1 }, spotify: { trackUri: `spotify:track:${id}`, confidence: 1 } } };
}

export function fixtureState(): RoomState {
  const queue: TrackRef[] = [
    track('t1', 'Pétala', 'Djavan', 'Bia', cover('oklch(0.64 0.21 35)', 'oklch(0.58 0.2 262)', 'oklch(0.8 0.17 85)', 'oklch(0.6 0.12 165)')),
    track('t2', 'Quando a Chuva Passar', 'Ivete Sangalo', 'Caio', cover('oklch(0.25 0.01 280)', 'oklch(0.7 0.08 50)', 'oklch(0.42 0.06 50)', 'oklch(0.15 0.01 280)')),
    track('t3', 'Tá Vendo Aquela Lua', 'Exaltasamba', 'Dani', cover('oklch(0.82 0.16 90)', 'oklch(0.5 0.13 150)', 'oklch(0.42 0.15 258)', 'oklch(0.91 0.03 95)')),
    track('t4', 'Sufoco', 'Alcione', 'Caio', cover('oklch(0.5 0.19 15)', 'oklch(0.78 0.14 75)', 'oklch(0.33 0.09 340)', 'oklch(0.2 0.04 10)')),
    track('t5', 'Eu Sei Que Vou Te Amar', 'Tom Jobim e Vinicius', 'Bia', cover('oklch(0.65 0 0)', 'oklch(0.85 0 0)', 'oklch(0.38 0 0)', 'oklch(0.22 0 0)')),
  ];
  return {
    roomId: 'SALABIA',
    name: 'Sala da Bia',
    queue,
    nowPlayingId: 't1',
    hostUserId: 'u-bia',
    admins: ['u-caio', 'u-dani'],
    radioEnabled: false,
    radioAvailable: true,
    version: 5,
    createdAt: NOW() - 12 * 60 * 1000,
    transport: { state: 'playing', positionMs: 84000, updatedAtServerMs: NOW() },
    votes: { t2: ['user:u-caio', 'user:u-dani'], t3: ['user:u-maju'], t4: ['user:u-bia'], t5: ['user:u-bia', 'user:u-dani'] },
  };
}

const MEMBERS: Member[] = [
  { clientId: 'c-bia', userId: 'u-bia', name: 'Bia', platform: 'spotify' },
  { clientId: 'c-caio', userId: 'u-caio', name: 'Caio', platform: 'youtube' },
  { clientId: 'c-dani', userId: 'u-dani', name: 'Dani', platform: 'apple' },
  { clientId: 'c-lucas', userId: 'u-lucas', name: 'Lucas', platform: 'spotify' },
  { clientId: 'c-maju', userId: 'u-maju', name: 'Maju', platform: 'youtube' },
];

// Characters of the fixture members (Modo palco); the extras of ?members=N keep
// the default derived from their userId.
const FIXTURE_CHARACTERS: Record<string, number> = { 'c-bia': 2, 'c-caio': 9, 'c-dani': 4, 'c-lucas': 1, 'c-maju': 7 };

const LONG_NAMES = ['Jalam pibau', 'Luk', 'Maria Eduarda Albuquerque', 'Joao Pedro', 'Anna Beatriz Souza', 'Lucas', 'Fernanda Cristina', 'Zé'];
const PLATFORMS: Member['platform'][] = ['spotify', 'youtube', 'apple', 'spotify', 'youtube', 'apple', 'spotify', 'youtube'];

// ?members=N (1..8) and ?long=1 reshape the stage for visual review.
function fixtureMembers(): Member[] {
  const q = new URLSearchParams(window.location.search);
  const n = Number(q.get('members'));
  if (!n || n < 1 || n > 8) return MEMBERS;
  const long = q.get('long') === '1';
  const out: Member[] = [];
  for (let i = 0; i < n; i++) {
    const base = MEMBERS[i];
    const name = long ? LONG_NAMES[i] : (base?.name ?? `Pessoa ${i + 1}`);
    out.push({ clientId: base?.clientId ?? `c-x${i}`, userId: base?.userId ?? `u-x${i}`, name, platform: PLATFORMS[i] });
  }
  // The viewer must stay in the list (the fixture is "Lucas").
  if (!out.some((m) => m.clientId === 'c-lucas')) out[out.length - 1] = { ...MEMBERS[3], name: long ? 'Luk' : 'Lucas' };
  return out;
}

function chatLines(): ChatMessage[] {
  const t = NOW();
  const m = (id: string, name: string, userId: string, text: string, ago: number): ChatMessage => ({ id, roomId: 'SALABIA', name, userId, text, sentAtServerMs: t - ago });
  return [
    m('m1', 'Caio', 'u-caio', 'essa abertura é absurda', 120000),
    m('m2', 'Dani', 'u-dani', 'próxima é minha, segura aí', 80000),
    m('m3', 'Bia', 'u-bia', 'votem na do Tom Jobim!', 30000),
  ];
}

// Minimal player so the transport is live (play/pause/next enabled) without an SDK.
export const fixturePlayer: IPlayer = {
  play: async () => {},
  pause: async () => {},
  seekToMs: async () => {},
  getCurrentPositionMs: async () => 84000,
  getDurationMs: async () => 214000,
  canSeek: () => true,
  onEnded: () => {},
  onPositionChanged: () => {},
};

export function applyRoomFixture(kind: FixtureKind): void {
  // A guest id so "Seus dados" has a code to show in the avatar menu.
  try {
    if (!getStoredUserId()) window.localStorage.setItem(USER_ID_KEY, 'ZaJTogIAKSyimQcFHPXE3Q');
  } catch {
    /* storage blocked: the menu simply omits "Seus dados" */
  }
  const s = useStore.getState();
  s.setName('Lucas');
  s.setClientId('c-lucas');
  s.setConnected(true);
  s.setState(fixtureState());
  s.setMembers(fixtureMembers());
  s.setCharacterOverrides(FIXTURE_CHARACTERS);
  s.setMyVotes({ t3: true });
  if (kind === 'room') s.setChat(chatLines());
}
