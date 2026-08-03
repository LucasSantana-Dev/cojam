import { describe, it, expect } from 'vitest';
import { generateRoomId } from './roomId';

describe('generateRoomId', () => {
  it('returns 12 uppercase base36 chars', () => {
    for (let i = 0; i < 100; i++) {
      expect(generateRoomId()).toMatch(/^[0-9A-Z]{12}$/);
    }
  });

  it('uses crypto.getRandomValues, not Math.random', () => {
    let cryptoCalls = 0;
    const original = crypto.getRandomValues.bind(crypto);
    const spy = <T extends Uint8Array>(arr: T): T => {
      cryptoCalls++;
      return original(arr);
    };
    crypto.getRandomValues = spy;
    try {
      generateRoomId();
    } finally {
      crypto.getRandomValues = original;
    }
    expect(cryptoCalls).toBeGreaterThan(0);
  });

  it('produces unique IDs across a large sample', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) ids.add(generateRoomId());
    expect(ids.size).toBe(10_000);
  });
});
