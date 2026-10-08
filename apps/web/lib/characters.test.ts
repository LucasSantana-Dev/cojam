import { describe, it, expect, beforeEach, vi } from 'vitest';
import { defaultCharacterId, memberCharacter, isCharacterId, CHARACTER_COUNT, CHARACTER_DEFAULT_POOL, CHARACTER_NAMES, CHARACTER_LABELS, portraitSrc } from './characters';

async function load() {
  vi.resetModules();
  return import('./characters');
}

describe('defaultCharacterId', () => {
  // The same table is pinned in apps/server/internal/hub/character_test.go.
  it.each([
    ['', 2],
    ['u-bia', 2],
    ['u-caio', 12],
    ['u-lucas', 6],
    ['sb:abc', 3],
    ['guest-7', 8],
  ])('%j gives %i (matches the server)', (seed, want) => {
    expect(defaultCharacterId(seed)).toBe(want);
    expect(defaultCharacterId(seed)).toBe(defaultCharacterId(seed));
  });

  it('stays in range and reaches every character', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const c = defaultCharacterId(`user-${i}`);
      expect(isCharacterId(c)).toBe(true);
      seen.add(c);
    }
    expect(seen.size).toBe(CHARACTER_DEFAULT_POOL);
    expect(seen.has(13)).toBe(false);
  });

  it('hashes UTF-8 bytes, not UTF-16 units', () => {
    expect(isCharacterId(defaultCharacterId('Zé 🎧'))).toBe(true);
  });
});

describe('roster', () => {
  it('has a label and a portrait path per character', () => {
    expect(CHARACTER_LABELS).toHaveLength(CHARACTER_COUNT);
    expect(CHARACTER_NAMES).toHaveLength(CHARACTER_COUNT);
    expect(CHARACTER_NAMES[12]).toBe('Mel');
    expect(CHARACTER_LABELS[12]).toBe('Cachos pretos volumosos e blusa vinho');
    expect(portraitSrc(3)).toBe('/palco/characters/03-portrait.png');
    expect(portraitSrc(12)).toBe('/palco/characters/12-portrait.png');
  });
  it.each([0, 14, 1.5, -1, NaN, '3'])('rejects %j', (v) => expect(isCharacterId(v)).toBe(false));
  it('accepts 13 as a pick but it is never a default', () => {
    expect(isCharacterId(13)).toBe(true);
    expect(portraitSrc(13)).toBe('/palco/characters/13-portrait.png');
  });
});

describe('memberCharacter', () => {
  it('prefers the choice, then the userId default, then the clientId default', () => {
    expect(memberCharacter({ characterId: 5, userId: 'u-bia', clientId: 'c1' })).toBe(5);
    expect(memberCharacter({ userId: 'u-bia', clientId: 'c1' })).toBe(2);
    expect(memberCharacter({ clientId: 'guest-7' })).toBe(8);
    expect(memberCharacter({ characterId: 99, userId: 'u-bia', clientId: 'c1' })).toBe(2);
  });
});

describe('stored choice', () => {
  beforeEach(() => window.localStorage.clear());

  it('is null until chosen', async () => {
    const m = await load();
    expect(m.getStoredCharacter()).toBeNull();
  });

  it('persists the choice and reads it back after a reload', async () => {
    const m = await load();
    m.setStoredCharacter(7);
    expect(window.localStorage.getItem(m.CHARACTER_KEY)).toBe('7');
    const again = await load();
    expect(again.getStoredCharacter()).toBe(7);
  });

  it('ignores an invalid stored value and an invalid set', async () => {
    window.localStorage.setItem('cojam.character', '40');
    const m = await load();
    expect(m.getStoredCharacter()).toBeNull();
    m.setStoredCharacter(0);
    expect(m.getStoredCharacter()).toBeNull();
  });

  it('survives blocked storage', async () => {
    const m = await load();
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(m.getStoredCharacter()).toBeNull();
    m.setStoredCharacter(4);
    expect(m.getStoredCharacter()).toBe(4);
    get.mockRestore();
    set.mockRestore();
  });
});
