// Modo palco: the pure layout rules of the pixel stage (docs/design/modo-palco.md,
// DESIGN.md "Modo palco"). No DOM, no three.js: the scene (app/room/components/
// palco/scene.ts) and the view read these, and the unit tests pin them.
//
// Coordinates: "world" is native pixels of the stage art (image coords, y grows
// down). The stage area draws the world scaled by one integer factor, so every
// world pixel is `scale` CSS pixels, never a fraction.
import type { RoomState, TrackRef } from '@cojam/shared';

export type WorldKind = 'wide' | 'phone';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoothDef {
  side: 'L' | 'R';
  // Left edge and head row of the DJ sprite (20x48) at full rise.
  x: number;
  top: number;
  // Wide plate: the booth front cropped from the art and drawn over the DJ,
  // so a sinking DJ disappears behind it. Phone plate: a small desk instead.
  cover?: [number, number, number, number];
  desk?: boolean;
}

export interface WorldDef {
  kind: WorldKind;
  W: number;
  H: number;
  src: string;
  // The stage screen: where the real YouTube player sits.
  screen: Rect;
  // Lowest world row of the live framing (front row feet sit around it).
  liveBottom: number;
  moon: [number, number];
  booths: [BoothDef, BoothDef];
  // Sine-wave screens on the speaker stacks (wide only).
  waves: Array<[number, number]>;
  // Beam origin x, y, angle, spread, length.
  beams: Array<[number, number, number, number, number]>;
  lamps: Array<[number, number]>;
  confetti: [number, number, number];
  // Background silhouette rows: first feet row, and how far above the crowd
  // bottom the last one stops.
  rowsFrom: number;
  rowsToOff: number;
  // Named audience rows: feet offset from the crowd bottom and spacing.
  frontOff: number;
  backOff: number;
  spacing: number;
}

export const WORLDS: Record<WorldKind, WorldDef> = {
  wide: {
    kind: 'wide',
    W: 360,
    H: 225,
    src: '/palco/stage-360-v10.png',
    screen: { x: 115, y: 78, w: 131, h: 74 },
    liveBottom: 250,
    moon: [292, -150],
    booths: [
      { side: 'L', x: 52, top: 104, cover: [30, 121, 60, 66] },
      { side: 'R', x: 289, top: 104, cover: [268, 121, 62, 66] },
    ],
    // Round 10 plate: its own booth screens carry the sine wave (no panel on top).
    waves: [],
    beams: [[96, 86, -0.55, 0.07, 150], [130, 60, -0.25, 0.06, 140], [230, 60, 0.25, 0.06, 140], [264, 86, 0.55, 0.07, 150], [47, 122, -0.75, 0.012, 260], [312, 122, 0.75, 0.012, 260]],
    lamps: [[83, 97], [82, 109], [269, 97], [271, 109]],
    confetti: [100, 260, 70],
    rowsFrom: 200,
    rowsToOff: 24,
    frontOff: 4,
    backOff: -10,
    spacing: 28,
  },
  phone: {
    kind: 'phone',
    W: 202,
    H: 360,
    src: '/palco/stage-phone-202-v10.png',
    screen: { x: 41, y: 75, w: 120, h: 70 },
    liveBottom: 268,
    moon: [150, -170],
    // The vertical plate crops the side booths: each DJ gets a small desk on the floor.
    booths: [
      { side: 'L', x: 8, top: 116, desk: true },
      { side: 'R', x: 174, top: 116, desk: true },
    ],
    waves: [],
    beams: [[51, 56, -0.45, 0.07, 150], [152, 56, 0.45, 0.07, 150], [10, 80, -0.85, 0.06, 130], [192, 76, 0.85, 0.06, 130], [30, 150, -0.35, 0.012, 220], [172, 150, 0.35, 0.012, 220]],
    lamps: [[11, 92], [10, 105], [183, 92], [185, 105]],
    confetti: [60, 142, 60],
    rowsFrom: 196,
    rowsToOff: 38,
    frontOff: 0,
    backOff: -16,
    spacing: 26,
  },
};

// Sprite geometry (public/palco/characters): 20x48 front/back, 28x58 arms up.
export const SPRITE_W = 20;
export const SPRITE_H = 48;
// The back sprite splits at the waist row so only the upper body bobs.
export const SPLIT = 29;

// Portrait windows (phones, tall desktop windows) get the vertical stage.
export function pickWorld(width: number, height: number): WorldKind {
  return width < 640 || height > width * 1.15 ? 'phone' : 'wide';
}

// Framing constants (owner-approved prototype): the stage pins near the top when
// there is spare height, the crowd grows by at most CROWD_EXTRA rows, and past
// that the view shrinks instead of showing empty ground.
export const STAGE_TOP = 18;
export const MAX_TOP = 70;
// Top row of the headphone arc on both plates: the framing tries to keep it.
export const FULL_TOP = 28;
export const CROWD_EXTRA = 40;
// Compact framing (phone with Fila or Chat open): the screen plus a thin strip.
export const COMPACT_PAD = 6;
// World pixels the scene draws past each side of the art (sky, ground, crowd).
export const SIDE_EXT = 60;

export interface Framing {
  scale: number;
  // Canvas size in world pixels.
  w: number;
  h: number;
  // Canvas left offset in CSS px inside the stage area (<= 0: centred crop).
  ox: number;
  // World pixel at the top left of the canvas.
  camLeft: number;
  camTop: number;
  // Feet row the named audience is laid out against.
  crowdBottom: number;
  // Height of the stage area in CSS px (may be less than offered: no empty ground).
  height: number;
  compact: boolean;
}

export function frameStage(world: WorldDef, cw: number, ch: number, compact = false): Framing {
  let scale = Math.max(2, Math.ceil(cw / world.W));
  // Short, wide windows: one step down when the whole stage (headphone arc to
  // front row) would not fit otherwise, as long as the plate stays close to the
  // full width (the scene extends the sky and ground a little past the art).
  while (scale > 2 && Math.floor(ch / scale) < world.liveBottom - FULL_TOP && Math.ceil(cw / (scale - 1)) <= world.W + 2 * SIDE_EXT) scale--;
  // The screen must always fit the width (tiny windows step the factor down).
  while (scale > 1 && Math.ceil(cw / scale) < world.screen.w + 4) scale--;
  const w = Math.ceil(cw / scale);
  const ox = Math.floor((cw - w * scale) / 2);
  const camLeft = Math.round(world.W / 2 - w / 2);
  const avail = Math.floor(ch / scale);
  // The player can be taller than the pixel screen (phones): reserve its rows.
  const player = playerSize(world, cw, scale);
  const centre = world.screen.y + world.screen.h / 2;
  const half = player.h / scale / 2;
  const minRows = Math.max(world.screen.h, Math.ceil(player.h / scale)) + 2 * COMPACT_PAD;
  if (compact || avail < minRows) {
    const h = minRows;
    return { scale, w, h, ox, camLeft, camTop: Math.round(centre - h / 2), crowdBottom: world.liveBottom, height: h * scale, compact: true };
  }
  let camTop: number;
  let crowdBottom: number;
  let height = ch;
  if (world.liveBottom - avail >= STAGE_TOP) {
    // Short window: crop the sky and the top of the truss, never the screen.
    camTop = Math.min(MAX_TOP, world.liveBottom - avail, world.screen.y - 2, Math.floor(centre - half) - 2);
    crowdBottom = world.liveBottom;
  } else {
    camTop = Math.min(STAGE_TOP, Math.floor(centre - half) - 2);
    crowdBottom = Math.min(STAGE_TOP + avail, world.liveBottom + CROWD_EXTRA);
    height = Math.min(ch, (crowdBottom - STAGE_TOP) * scale);
  }
  const h = Math.ceil(height / scale);
  return { scale, w, h, ox, camLeft, camTop, crowdBottom, height, compact: false };
}

// World point to stage-area CSS px.
export function toCss(f: Framing, wx: number, wy: number): [number, number] {
  return [Math.round((wx - f.camLeft) * f.scale + f.ox), Math.round((wy - f.camTop) * f.scale)];
}

// The YouTube player is at least PLAYER_MIN x PLAYER_MIN CSS px, always (API
// terms). On the vertical stage the owner chose (2026-10-08, "A") a full-width
// 16:9 player over the stage screen, allowed to cover the scene art around it
// (truss, booths): about 356x200 at 390 wide. On the wide stage it is the pixel
// screen itself, enlarged the same way only when a small factor makes the
// screen shorter than PLAYER_MIN.
export const PLAYER_MIN = 200;
export const PLAYER_GUTTER = 17;

export function playerSize(world: WorldDef, cw: number, scale: number): { w: number; h: number } {
  const sw = world.screen.w * scale, sh = world.screen.h * scale;
  if (world.kind === 'wide' && sw >= PLAYER_MIN && sh >= PLAYER_MIN) return { w: sw, h: sh };
  const room = Math.max(PLAYER_MIN, cw - 2 * PLAYER_GUTTER);
  const w = world.kind === 'phone' ? room : Math.min(room, Math.max(sw, Math.ceil((PLAYER_MIN * 16) / 9)));
  return { w, h: Math.max(PLAYER_MIN, Math.round((w * 9) / 16)) };
}

// The player rectangle in stage-area CSS px: centred on the pixel screen
// (horizontally on the stage area for the vertical stage), inside the view.
export function playerRect(world: WorldDef, f: Framing, cw: number): Rect {
  const s = screenRect(world, f);
  const { w, h } = playerSize(world, cw, f.scale);
  if (w === s.w && h === s.h) return s;
  const cx = world.kind === 'phone' ? cw / 2 : s.x + s.w / 2;
  const x = Math.max(0, Math.min(cw - w, Math.round(cx - w / 2)));
  const y = Math.max(0, Math.min(f.height - h, Math.round(s.y + s.h / 2 - h / 2)));
  return { x, y, w, h };
}

// On the vertical stage the player covers the booths drawn in the art, so the
// DJs stand just below it: their head row in world px.
export function boothTop(world: WorldDef, f: Framing, player: Rect): number {
  const below = f.camTop + Math.ceil((player.y + player.h) / f.scale) + 2;
  return world.kind === 'phone' ? Math.max(world.booths[0].top, below) : world.booths[0].top;
}

// --- "A seguir": the LED setlist board ----------------------------------------

// Up to BOARD_MAX upcoming tracks, one row each under a header, in CSS px.
export const BOARD_MAX = 3;
export const BOARD_HEAD = 16;
export const BOARD_ROW = 15;
export const BOARD_PAD = 5;
// Rows a name tag takes above a head (tag height plus its gap).
const TAG_ROOM = 24;

// The tracks after the playing one, in queue order (the same order nextTrack reads).
export function upNext(state: Pick<RoomState, 'queue' | 'nowPlayingId'> | null | undefined, n = BOARD_MAX): TrackRef[] {
  if (!state) return [];
  return state.queue.filter((t) => t.id !== state.nowPlayingId).slice(0, n);
}

// Where the board goes, in stage-area CSS px, and how many rows fit; null when
// there is nothing to show or no room. Always under the player, never over it:
// on the wide stage on the apron under the screen, as wide as the screen; on
// the vertical stage between the two floor desks, above the booth tags. It
// stops above the named crowd's tags and drops rows rather than touch them.
export function boardRect(world: WorldDef, f: Framing, player: Rect, count: number): (Rect & { rows: number }) | null {
  if (f.compact || count <= 0) return null;
  const y = player.y + player.h + 2 * f.scale;
  const heads = f.crowdBottom + Math.min(world.frontOff, world.backOff) - SPRITE_H;
  let bottom = toCss(f, 0, heads)[1] - TAG_ROOM;
  let x = player.x;
  let w = player.w;
  if (world.kind === 'phone') {
    // Desks span the DJ's x - 4 to x + 24; leave 4 world px of air.
    const [l] = toCss(f, world.booths[0].x + SPRITE_W + 8, 0);
    const [r] = toCss(f, world.booths[1].x - 8, 0);
    x = l;
    w = r - l;
    // The booth tags hang under the desks (desk bottom: head row + 44).
    bottom = Math.min(bottom, toCss(f, 0, boothTop(world, f, player) + 44)[1] - 4);
  }
  const rows = Math.min(count, BOARD_MAX, Math.floor((bottom - y - 2 * BOARD_PAD - BOARD_HEAD) / BOARD_ROW));
  if (rows < 1 || w < 120) return null;
  return { x, y, w, h: 2 * BOARD_PAD + BOARD_HEAD + rows * BOARD_ROW, rows };
}

// The stage screen in stage-area CSS px (the pixel art's screen).
export function screenRect(world: WorldDef, f: Framing): Rect {
  const [x, y] = toCss(f, world.screen.x, world.screen.y);
  return { x, y, w: world.screen.w * f.scale, h: world.screen.h * f.scale };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// --- who is where ------------------------------------------------------------

export interface PalcoMember {
  clientId: string;
  clientIds?: string[];
  userId?: string;
  name: string;
}

export function memberKey(m: PalcoMember): string {
  return m.userId ? `u:${m.userId}` : `c:${m.clientId}`;
}

// The member who queued a track: the server-stamped userId first, else the
// display name (rooms without auth). Absent when they left the room.
export function memberForTrack<M extends PalcoMember>(track: Pick<TrackRef, 'addedBy' | 'addedByUserId'> | undefined, members: readonly M[]): M | null {
  if (!track) return null;
  if (track.addedByUserId) {
    const byId = members.find((m) => m.userId === track.addedByUserId);
    if (byId) return byId;
  }
  const name = track.addedBy?.trim();
  if (!name) return null;
  return members.find((m) => m.name === name) ?? null;
}

// The track after the playing one: the queue's first entry that is not playing.
export function nextTrack(state: Pick<RoomState, 'queue' | 'nowPlayingId'> | null | undefined): TrackRef | undefined {
  if (!state) return undefined;
  return state.queue.find((t) => t.id !== state.nowPlayingId);
}

export interface Booths<M> {
  left: M | null;
  right: M | null;
}

// Left booth: who queued the playing track ("Nome · tocando"). Right booth: who
// queued the next one ("Nome · próxima"). One person never stands in both: when
// the same member queued both, the right booth stays empty.
export function boothMembers<M extends PalcoMember>(state: Pick<RoomState, 'queue' | 'nowPlayingId'> | null | undefined, members: readonly M[]): Booths<M> {
  if (!state) return { left: null, right: null };
  const playing = state.nowPlayingId ? state.queue.find((t) => t.id === state.nowPlayingId) : undefined;
  const left = memberForTrack(playing, members);
  const right = memberForTrack(nextTrack(state), members);
  return { left, right: right && left && memberKey(right) === memberKey(left) ? null : right };
}

// The crowd is everyone in the room except the people at a booth.
export function crowdMembers<M extends PalcoMember>(members: readonly M[], booths: Booths<M>): M[] {
  const out = new Set([booths.left, booths.right].filter((m): m is M => Boolean(m)).map(memberKey));
  return members.filter((m) => !out.has(memberKey(m)));
}

export interface Slot {
  // Sprite left edge and feet row, in world px.
  x: number;
  feet: number;
  row: 0 | 1;
}

// Audience slots: a front row centred on the view, then a dimmer row behind it
// offset by half a step. `you` (index youIndex) goes to the middle of the front
// row. Returns one slot per shown member, in input order, plus how many did not fit.
export function crowdSlots(n: number, world: WorldDef, f: Pick<Framing, 'camLeft' | 'w' | 'crowdBottom'>, youIndex = -1): { slots: Slot[]; overflow: number } {
  const step = world.spacing;
  const left = f.camLeft + 4;
  const right = f.camLeft + f.w - SPRITE_W - 4;
  const span = Math.max(0, right - left);
  const frontCap = Math.max(1, Math.floor(span / step) + 1);
  const backCap = Math.max(0, Math.floor(Math.max(0, span - step / 2) / step) + 1);
  const shown = Math.min(n, frontCap + backCap);
  const front = Math.min(shown, frontCap);
  const back = shown - front;
  const rowXs = (count: number, offset: number) => {
    const width = (count - 1) * step;
    const start = Math.round(f.camLeft + f.w / 2 - SPRITE_W / 2 - width / 2 + offset);
    return Array.from({ length: count }, (_, i) => start + i * step);
  };
  const frontXs = rowXs(front, 0);
  const backXs = rowXs(back, back === front ? step / 2 : 0);
  // Order: you in the middle of the front row, the others filling around.
  const order = Array.from({ length: n }, (_, i) => i).filter((i) => i !== youIndex);
  if (youIndex >= 0 && youIndex < n) order.splice(Math.min(Math.floor(front / 2), order.length), 0, youIndex);
  const slots: Slot[] = new Array(n);
  order.slice(0, shown).forEach((member, k) => {
    slots[member] = k < front
      ? { x: frontXs[k], feet: f.crowdBottom + world.frontOff, row: 0 }
      : { x: backXs[k - front], feet: f.crowdBottom + world.backOff, row: 1 };
  });
  return { slots, overflow: n - shown };
}

// --- reactions -----------------------------------------------------------------

// Voter keys that appear in `next` but not in `prev` (upvotes since the last state).
export function newVoters(prev: RoomState['votes'] | undefined, next: RoomState['votes'] | undefined): string[] {
  if (!next) return [];
  const out: string[] = [];
  for (const [trackId, voters] of Object.entries(next)) {
    const before = new Set(prev?.[trackId] ?? []);
    for (const v of voters) if (!before.has(v)) out.push(v);
  }
  return out;
}

// Vote keys are user:<userId> (room auth) or client:<clientId> (docs/protocol.md).
export function memberForVoter<M extends PalcoMember>(key: string, members: readonly M[]): M | null {
  if (key.startsWith('user:')) {
    const id = key.slice(5);
    return members.find((m) => m.userId === id) ?? null;
  }
  if (key.startsWith('client:')) {
    const id = key.slice(7);
    return members.find((m) => (m.clientIds ?? [m.clientId]).includes(id)) ?? null;
  }
  return null;
}

export function memberForClient<M extends PalcoMember>(clientId: string, members: readonly M[]): M | null {
  return members.find((m) => (m.clientIds ?? [m.clientId]).includes(clientId)) ?? null;
}

// --- overlays (DOM, CSS px of the stage area) -----------------------------------

const GAP = 6;

// A chat bubble above a head: clamped inside the view, and pushed below the
// screen when it would touch it. Never over the video.
export function placeBubble(anchorX: number, headTop: number, bw: number, bh: number, viewW: number, screen: Rect): { left: number; top: number; tail: number } {
  const left = Math.max(8, Math.min(viewW - bw - 8, Math.round(anchorX - bw / 2)));
  let top = Math.round(headTop - bh - 14);
  if (intersects({ x: left, y: top, w: bw, h: bh }, screen)) top = screen.y + screen.h + GAP;
  const tail = Math.max(10, Math.min(bw - 10, Math.round(anchorX - left)));
  return { left, top, tail };
}

// A name tag centred above (or, with below, under) an anchor: clamped inside the
// view and pushed below the screen when it would touch it.
export function placeTag(anchorX: number, anchorY: number, tw: number, th: number, viewW: number, screen: Rect, below = false): { left: number; top: number } {
  const left = Math.max(4, Math.min(viewW - tw - 4, Math.round(anchorX - tw / 2)));
  let top = below ? Math.round(anchorY + 2) : Math.round(anchorY - th - 4);
  if (intersects({ x: left, y: top, w: tw, h: th }, screen)) top = screen.y + screen.h + GAP;
  return { left, top };
}
