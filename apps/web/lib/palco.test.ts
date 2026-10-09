import { describe, it, expect } from 'vitest';
import type { RoomState, TrackRef } from '@cojam/shared';
import {
  WORLDS, pickWorld, frameStage, screenRect, playerRect, boothTop, intersects, toCss,
  boothMembers, crowdMembers, crowdSlots, nextTrack, memberForTrack,
  newVoters, memberForVoter, memberForClient, placeBubble, placeTag,
  STAGE_TOP, CROWD_EXTRA, COMPACT_PAD, upNext, boardRect, BOARD_MAX, SPRITE_H, EDGE_COLS, plainSideColours, tagName, phoneTagMaxWidth, type PalcoMember,
} from './palco';

const t = (id: string, addedBy: string, addedByUserId?: string): TrackRef => ({ id, title: id, artist: 'A', addedBy, addedByUserId, sources: {} });
const room = (queue: TrackRef[], nowPlayingId?: string): Pick<RoomState, 'queue' | 'nowPlayingId'> => ({ queue, nowPlayingId });

const BIA: PalcoMember = { clientId: 'c-bia', userId: 'u-bia', name: 'Bia' };
const CAIO: PalcoMember = { clientId: 'c-caio', userId: 'u-caio', name: 'Caio' };
const DANI: PalcoMember = { clientId: 'c-dani', clientIds: ['c-dani', 'c-dani2'], name: 'Dani' };
const LUCAS: PalcoMember = { clientId: 'c-lucas', userId: 'u-lucas', name: 'Lucas' };
const MEMBERS = [BIA, CAIO, DANI, LUCAS];

describe('pickWorld', () => {
  it('is vertical below 640 wide or when the window is tall', () => {
    expect(pickWorld(390, 844)).toBe('phone');
    expect(pickWorld(639, 400)).toBe('phone');
    expect(pickWorld(1440, 900)).toBe('wide');
    expect(pickWorld(800, 900)).toBe('wide');
    expect(pickWorld(800, 940)).toBe('phone');
  });
});

describe('frameStage', () => {
  const wide = WORLDS.wide;
  const phone = WORLDS.phone;

  it('scales by a whole factor that covers the width', () => {
    for (const cw of [640, 700, 1024, 1080, 1440, 1920]) {
      const f = frameStage(wide, cw, 800);
      expect(Number.isInteger(f.scale)).toBe(true);
      expect(f.w * f.scale).toBeGreaterThanOrEqual(cw);
      expect(f.ox).toBeLessThanOrEqual(0);
    }
    expect(frameStage(wide, 1440, 1000).scale).toBe(4);
    expect(frameStage(phone, 390, 700).scale).toBe(2);
  });

  it('crops the sky on short windows, never the screen', () => {
    const f = frameStage(wide, 1440, 600);
    expect(f.camTop).toBeGreaterThan(STAGE_TOP);
    expect(f.camTop).toBeLessThanOrEqual(wide.screen.y);
    expect(f.crowdBottom).toBe(wide.liveBottom);
    expect(f.height).toBe(600);
    const s = screenRect(wide, f);
    expect(s.y).toBeGreaterThanOrEqual(0);
    expect(s.y + s.h).toBeLessThanOrEqual(f.height);
  });

  it('steps the factor down on short wide windows only while the plate nearly fills the width', () => {
    // 1280x560: x4 would cut the headphone arc and the front row, x3 keeps the
    // whole stage and overflows the art by 54 px a side.
    expect(frameStage(wide, 1280, 560).scale).toBe(3);
    // Tall enough for the whole stage at x4: no step.
    expect(frameStage(wide, 1440, 1000).scale).toBe(4);
    // 1440x700 at x3 needs 480 px of world: exactly the art plus both side extensions.
    expect(frameStage(wide, 1440, 700).scale).toBe(3);
    // 1600 wide steps from x5 to x4, never to x3 (534 px of world: past the extensions).
    expect(frameStage(wide, 1600, 700).scale).toBe(4);
  });

  it('pins the stage near the top and grows the crowd at most CROWD_EXTRA rows on tall windows', () => {
    const f = frameStage(phone, 390, 2000);
    expect(f.camTop).toBe(STAGE_TOP);
    expect(f.crowdBottom).toBe(phone.liveBottom + CROWD_EXTRA);
    // The view shrinks to fit: no empty ground below the crowd.
    expect(f.height).toBe((phone.liveBottom + CROWD_EXTRA - STAGE_TOP) * f.scale);
  });

  it('uses the offered height between the two regimes', () => {
    const f = frameStage(phone, 390, 520);
    expect(f.camTop).toBe(STAGE_TOP);
    expect(f.crowdBottom).toBe(STAGE_TOP + 260);
    expect(f.height).toBe(520);
  });

  it('compact framing is the player plus a thin strip, and short windows fall back to it', () => {
    const f = frameStage(phone, 390, 900, true);
    expect(f.compact).toBe(true);
    const p = playerRect(phone, f, 390);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y + p.h).toBeLessThanOrEqual(f.height);
    const short = frameStage(wide, 1440, 120);
    expect(short.compact).toBe(true);
    // The wide stage keeps the thin strip: the screen plus padding.
    expect(short.height).toBe((wide.screen.h + 2 * COMPACT_PAD) * short.scale);
  });

  it('compact phone framing keeps the front row in view under the player, at the same scale', () => {
    const open = frameStage(phone, 390, 520);
    const f = frameStage(phone, 390, 520, true);
    expect(f.scale).toBe(open.scale);
    expect(f.scale).toBe(2);
    const p = playerRect(phone, f, 390);
    expect(p.y).toBe(COMPACT_PAD * f.scale);
    // From the player's bottom to the bottom of the view: at least 110 CSS px of crowd.
    expect(f.height - (p.y + p.h)).toBeGreaterThanOrEqual(110);
    // Heads (and their tags) clear of the player, feet inside the view.
    const { slots } = crowdSlots(8, phone, f, 3);
    const feetCss = toCss(f, 0, slots[0].feet)[1];
    const headCss = toCss(f, 0, slots[0].feet - SPRITE_H)[1];
    expect(headCss - 24).toBeGreaterThanOrEqual(p.y + p.h);
    expect(feetCss).toBeLessThanOrEqual(f.height);
    // The DJs step out of the strip rather than stand over the crowd.
    expect(toCss(f, 0, boothTop(phone, f, p))[1]).toBeGreaterThanOrEqual(f.height);
    for (const [cw, ch] of [[360, 500], [414, 540]] as const) {
      const g = frameStage(phone, cw, ch, true);
      expect(g.scale).toBe(2);
      expect(g.height).toBeLessThanOrEqual(380);
    }
  });

  it('keeps the player at least 200x200 CSS px and inside the view', () => {
    for (const [world, cw, ch] of [[phone, 390, 620], [phone, 375, 560], [phone, 390, 400], [wide, 1440, 760], [wide, 1040, 760], [wide, 700, 500], [wide, 640, 300]] as const) {
      for (const compact of [false, true]) {
        const f = frameStage(world, cw, ch, compact);
        const p = playerRect(world, f, cw);
        expect(p.w).toBeGreaterThanOrEqual(200);
        expect(p.h).toBeGreaterThanOrEqual(200);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x + p.w).toBeLessThanOrEqual(cw);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y + p.h).toBeLessThanOrEqual(f.height);
      }
    }
  });

  it('phones get a full-width 16:9 player over the stage screen (owner decision A)', () => {
    const f = frameStage(phone, 390, 620);
    const p = playerRect(phone, f, 390);
    expect(p).toMatchObject({ x: 17, w: 356, h: 200 });
    const s = screenRect(phone, f);
    expect(Math.abs(p.y + p.h / 2 - (s.y + s.h / 2))).toBeLessThanOrEqual(1);
    // The DJs move just below it.
    const top = boothTop(phone, f, p);
    expect(toCss(f, 0, top)[1]).toBeGreaterThanOrEqual(p.y + p.h);
  });

  it('the wide stage keeps the pixel screen when it is big enough, else enlarges it', () => {
    const f = frameStage(wide, 1440, 760);
    expect(playerRect(wide, f, 1440)).toEqual(screenRect(wide, f));
    expect(boothTop(wide, f, screenRect(wide, f))).toBe(wide.booths[0].top);
    const small = frameStage(wide, 700, 500);
    expect(small.scale).toBe(2);
    expect(playerRect(wide, small, 700).h).toBe(200);
  });

  it('maps world pixels to whole CSS pixels', () => {
    const f = frameStage(wide, 1440, 760);
    const [x, y] = toCss(f, wide.screen.x, wide.screen.y);
    expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
    expect(x).toBe((wide.screen.x - f.camLeft) * f.scale + f.ox);
  });
});

describe('booths and crowd', () => {
  it('left is who queued the playing track, right who queued the next one', () => {
    const state = room([t('t1', 'Bia', 'u-bia'), t('t2', 'Caio', 'u-caio'), t('t3', 'Dani')], 't1');
    expect(boothMembers(state, MEMBERS)).toEqual({ left: BIA, right: CAIO });
  });

  it('the next track skips the playing one wherever it sits', () => {
    const state = room([t('t2', 'Caio'), t('t1', 'Bia'), t('t3', 'Dani')], 't1');
    expect(nextTrack(state)?.id).toBe('t2');
  });

  it('matches by userId first, then by name, and leaves an absent adder out', () => {
    expect(memberForTrack(t('x', 'Outro nome', 'u-caio'), MEMBERS)).toBe(CAIO);
    expect(memberForTrack(t('x', 'Dani'), MEMBERS)).toBe(DANI);
    expect(memberForTrack(t('x', 'Rádio'), MEMBERS)).toBeNull();
    expect(boothMembers(room([t('t1', 'Saiu', 'u-gone')], 't1'), MEMBERS)).toEqual({ left: null, right: null });
  });

  it('one person never takes both booths', () => {
    const state = room([t('t1', 'Bia', 'u-bia'), t('t2', 'Bia', 'u-bia')], 't1');
    expect(boothMembers(state, MEMBERS)).toEqual({ left: BIA, right: null });
  });

  it('no state, no booths', () => {
    expect(boothMembers(null, MEMBERS)).toEqual({ left: null, right: null });
  });

  it('someone at a booth is not also in the crowd', () => {
    const crowd = crowdMembers(MEMBERS, { left: BIA, right: CAIO });
    expect(crowd).toEqual([DANI, LUCAS]);
    expect(crowdMembers(MEMBERS, { left: null, right: null })).toEqual(MEMBERS);
  });
});

describe('crowdSlots', () => {
  const wide = WORLDS.wide;
  const f = frameStage(wide, 1440, 760);

  it('puts you in the middle of the front row and spaces the row evenly', () => {
    const { slots, overflow } = crowdSlots(5, wide, f, 4);
    expect(overflow).toBe(0);
    const front = slots.filter((s) => s.row === 0).map((s) => s.x).sort((a, b) => a - b);
    expect(front).toHaveLength(5);
    expect(slots[4].x).toBe(front[2]);
    for (let i = 1; i < front.length; i++) expect(front[i] - front[i - 1]).toBe(wide.spacing);
    expect(slots.every((s) => s.feet === f.crowdBottom + wide.frontOff)).toBe(true);
  });

  it('fills a dimmer back row on the wide stage and reports what does not fit', () => {
    const { slots: wideSlots } = crowdSlots(40, wide, f, 0);
    expect(wideSlots.filter(Boolean).some((s) => s.row === 1)).toBe(true);
    expect(wide.spacing).toBe(28);
  });

  it('the phone shows only a front row, 36 world px apart, and counts the rest as overflow', () => {
    const phone = WORLDS.phone;
    expect(phone.spacing).toBe(36);
    for (const [cw, ch] of [[390, 520], [360, 480], [414, 540]] as const) {
      for (const compact of [false, true]) {
        const pf = frameStage(phone, cw, ch, compact);
        const { slots, overflow } = crowdSlots(11, phone, pf, 4);
        const shown = slots.filter(Boolean);
        expect(shown).toHaveLength(5);
        expect(shown.every((s) => s.row === 0)).toBe(true);
        expect(overflow).toBe(6);
        // You stay on stage, in the middle.
        expect(slots[4]).toBeDefined();
        const xs = shown.map((s) => s.x).sort((a, b) => a - b);
        expect(slots[4].x).toBe(xs[2]);
        for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBe(36);
      }
    }
    const pf = frameStage(phone, 390, 620);
    const { slots, overflow } = crowdSlots(40, phone, pf, 0);
    const shown = slots.filter(Boolean);
    expect(overflow).toBe(40 - shown.length);
    for (const s of shown) {
      expect(s.x).toBeGreaterThanOrEqual(pf.camLeft);
      expect(s.x + 20).toBeLessThanOrEqual(pf.camLeft + pf.w);
    }
    expect(slots[0].row).toBe(0);
    expect(tagName('Maria Eduarda Albuquerque', ' 2')).toBe('Maria 2');
    expect(tagName('  Zé ')).toBe('Zé');
    expect(phoneTagMaxWidth(phone, 2)).toBe(70);
    expect(phoneTagMaxWidth(phone, 3)).toBe(106);
  });

  it('a room of one is one person, centred', () => {
    const { slots } = crowdSlots(1, wide, f, 0);
    expect(Math.abs(slots[0].x + 10 - (f.camLeft + f.w / 2))).toBeLessThanOrEqual(1);
  });
});

describe('reactions', () => {
  it('finds the new voters between two states', () => {
    expect(newVoters({ t2: ['user:u-caio'] }, { t2: ['user:u-caio', 'user:u-bia'], t3: ['client:c-dani2'] })).toEqual(['user:u-bia', 'client:c-dani2']);
    expect(newVoters(undefined, undefined)).toEqual([]);
    expect(newVoters({ t2: ['user:u-caio'] }, {})).toEqual([]);
  });

  it('maps a voter key or a connection to the member', () => {
    expect(memberForVoter('user:u-bia', MEMBERS)).toBe(BIA);
    expect(memberForVoter('client:c-dani2', MEMBERS)).toBe(DANI);
    expect(memberForVoter('client:ghost', MEMBERS)).toBeNull();
    expect(memberForVoter('weird', MEMBERS)).toBeNull();
    expect(memberForClient('c-dani2', MEMBERS)).toBe(DANI);
  });
});

describe('overlays never touch the screen', () => {
  const screen = { x: 100, y: 50, w: 300, h: 170 };

  it('a bubble above a head sits above it, clamped inside the view', () => {
    const p = placeBubble(20, 400, 120, 30, 500, screen);
    expect(p.left).toBe(8);
    expect(p.top).toBe(400 - 30 - 14);
    expect(p.tail).toBeGreaterThanOrEqual(10);
    expect(placeBubble(495, 400, 120, 30, 500, screen).left).toBe(500 - 120 - 8);
  });

  it('a bubble that would cover the screen moves below it', () => {
    const p = placeBubble(250, 230, 160, 30, 500, screen);
    expect(intersects({ x: p.left, y: p.top, w: 160, h: 30 }, screen)).toBe(false);
    expect(p.top).toBeGreaterThanOrEqual(screen.y + screen.h);
  });

  it('a tag that would cover the screen moves below it', () => {
    const p = placeTag(120, 120, 90, 18, 500, screen);
    expect(intersects({ x: p.left, y: p.top, w: 90, h: 18 }, screen)).toBe(false);
    const below = placeTag(30, 300, 60, 18, 500, screen, true);
    expect(below.top).toBe(302);
  });
});

describe('"A seguir" board', () => {
  it('lists up to three tracks after the playing one, in queue order', () => {
    const q = [t('a', 'Bia'), t('b', 'Caio'), t('c', 'Dani'), t('d', 'Bia'), t('e', 'Caio')];
    expect(upNext(room(q, 'a')).map((x) => x.id)).toEqual(['b', 'c', 'd']);
    expect(upNext(room(q, 'c')).map((x) => x.id)).toEqual(['a', 'b', 'd']);
    expect(upNext(room([t('a', 'Bia')], 'a'))).toEqual([]);
    expect(upNext(null)).toEqual([]);
  });

  const sizes: Array<[number, number]> = [[390, 844], [390, 664], [360, 740], [430, 932], [1440, 900], [1280, 720], [1024, 768], [1920, 1080], [800, 600]];
  it.each(sizes)('never touches the player or the crowd tags at %ix%i', (vw, vh) => {
    const world = WORLDS[pickWorld(vw, vh)];
    const ch = vh - (world.kind === 'phone' ? 330 : 150); // header and HUD
    const f = frameStage(world, vw, ch);
    const player = playerRect(world, f, vw);
    const b = boardRect(world, f, player, BOARD_MAX);
    if (!b) return; // no room: hidden, which is allowed
    expect(intersects(b, player)).toBe(false);
    expect(b.y).toBeGreaterThanOrEqual(player.y + player.h);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.w).toBeLessThanOrEqual(vw);
    expect(b.rows).toBeGreaterThanOrEqual(1);
    expect(b.rows).toBeLessThanOrEqual(BOARD_MAX);
    const heads = toCss(f, 0, f.crowdBottom + Math.min(world.frontOff, world.backOff) - SPRITE_H)[1];
    expect(b.y + b.h).toBeLessThanOrEqual(heads - 20);
  });

  it('shows all three rows at 390x844 and 1440x900', () => {
    for (const [vw, ch] of [[390, 844 - 330], [1440, 900 - 150]]) {
      const world = WORLDS[pickWorld(vw, ch + 150)];
      const f = frameStage(world, vw, ch);
      expect(boardRect(world, f, playerRect(world, f, vw), 3)?.rows).toBe(3);
    }
  });

  it('is hidden with an empty queue or the compact phone framing', () => {
    const world = WORLDS.phone;
    const f = frameStage(world, 390, 500);
    expect(boardRect(world, f, playerRect(world, f, 390), 0)).toBeNull();
    const c = frameStage(world, 390, 500, true);
    expect(boardRect(world, c, playerRect(world, c, 390), 3)).toBeNull();
  });
});


describe('plainSideColours', () => {
  // A 10 x 4 plate: row 0 dark sky, row 1 a bright beam and a tower at the
  // edge, row 2 a busy edge, row 3 dark ground.
  const SKY = 0x0d0b1c, GROUND = 0x131026, TOWER = 0x2a1e46, BEAM = 0xa76ef8;
  const rows = [
    Array(10).fill(SKY),
    [BEAM, BEAM, BEAM, BEAM, BEAM, BEAM, TOWER, TOWER, SKY, SKY],
    [TOWER, SKY, TOWER, GROUND, TOWER, SKY, GROUND, SKY, SKY, SKY],
    Array(10).fill(GROUND),
  ];
  const px = new Uint8ClampedArray(10 * 4 * 4);
  rows.forEach((r, y) => r.forEach((c, x) => {
    const i = (y * 10 + x) * 4;
    px[i] = c >> 16; px[i + 1] = (c >> 8) & 255; px[i + 2] = c & 255; px[i + 3] = 255;
  }));

  it('takes the dominant dark colour of the outer columns and carries it over busy rows', () => {
    expect(EDGE_COLS).toBe(8);
    expect(plainSideColours(px, 10, 4, 0)).toEqual([SKY, SKY, SKY, GROUND]);
  });

  it('never extends a bright beam colour, even when it is the row majority', () => {
    // Row 1 over columns 0..7 is 6 beam pixels of 8: only the brightness gate keeps it out.
    const lum = (c: number) => (c >> 16) * 0.3 + ((c >> 8) & 255) * 0.59 + (c & 255) * 0.11;
    expect(lum(BEAM)).toBeGreaterThan(50);
    const out = plainSideColours(px, 10, 4, 0);
    expect(out).not.toContain(BEAM);
    expect(out[1]).toBe(SKY);
  });

  it('reads the right edge (x0 = W - EDGE_COLS) and stays within the plate', () => {
    expect(plainSideColours(px, 10, 4, 10 - EDGE_COLS)).toEqual([SKY, SKY, SKY, GROUND]);
  });
});
