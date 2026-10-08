import { describe, it, expect } from 'vitest';
import type { RoomState, TrackRef } from '@cojam/shared';
import {
  WORLDS, pickWorld, frameStage, screenRect, intersects, toCss,
  boothMembers, crowdMembers, crowdSlots, nextTrack, memberForTrack,
  newVoters, memberForVoter, memberForClient, placeBubble, placeTag,
  STAGE_TOP, CROWD_EXTRA, COMPACT_PAD, type PalcoMember,
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

  it('compact framing is the screen plus a thin strip, and short windows fall back to it', () => {
    const f = frameStage(phone, 390, 900, true);
    expect(f.compact).toBe(true);
    expect(f.camTop).toBe(phone.screen.y - COMPACT_PAD);
    expect(f.height).toBe((phone.screen.h + 2 * COMPACT_PAD) * f.scale);
    expect(frameStage(wide, 1440, 120).compact).toBe(true);
  });

  it('keeps the screen at least 200 CSS px wide and inside the view at 390 and 1440', () => {
    for (const [world, cw, ch] of [[phone, 390, 620], [wide, 1440, 760], [wide, 1040, 760], [phone, 390, 600]] as const) {
      for (const compact of [false, true]) {
        const f = frameStage(world, cw, ch, compact);
        const s = screenRect(world, f);
        expect(s.w).toBeGreaterThanOrEqual(200);
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.x + s.w).toBeLessThanOrEqual(cw);
        expect(s.y + s.h).toBeLessThanOrEqual(f.height);
      }
    }
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

  it('fills a dimmer back row and reports what does not fit', () => {
    const phone = WORLDS.phone;
    const pf = frameStage(phone, 390, 620);
    const { slots, overflow } = crowdSlots(40, phone, pf, 0);
    const shown = slots.filter(Boolean);
    expect(shown.some((s) => s.row === 1)).toBe(true);
    expect(overflow).toBe(40 - shown.length);
    for (const s of shown) {
      expect(s.x).toBeGreaterThanOrEqual(pf.camLeft);
      expect(s.x + 20).toBeLessThanOrEqual(pf.camLeft + pf.w);
    }
    expect(slots[0].row).toBe(0);
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
