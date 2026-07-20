import { describe, it, expect } from 'vitest';
import { mergeProviderPrefs } from './account';

describe('mergeProviderPrefs', () => {
  it('returns empty when nothing is connected anywhere', () => {
    expect(mergeProviderPrefs([], {})).toEqual([]);
  });

  it('uses live state alone for guests (no persisted services)', () => {
    expect(mergeProviderPrefs([], { spotify: true })).toEqual(['spotify']);
  });

  it('uses persisted services alone when live state has not settled', () => {
    expect(mergeProviderPrefs(['spotify'], {})).toEqual(['spotify']);
  });

  it('unions both sources without duplicates, canonical order', () => {
    expect(mergeProviderPrefs(['apple'], { spotify: true })).toEqual(['spotify', 'apple']);
    expect(mergeProviderPrefs(['spotify'], { spotify: true })).toEqual(['spotify']);
  });

  it('ignores unknown persisted providers', () => {
    expect(mergeProviderPrefs(['tidal', 'spotify'], {})).toEqual(['spotify']);
  });
});
