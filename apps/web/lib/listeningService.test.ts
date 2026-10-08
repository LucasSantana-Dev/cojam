import { describe, it, expect, beforeEach, vi } from 'vitest';

async function load() {
  vi.resetModules();
  return import('./listeningService');
}

describe('listening service preference', () => {
  beforeEach(() => window.localStorage.clear());

  it('defaults to auto', async () => {
    const m = await load();
    expect(m.getListeningService()).toBe('auto');
  });

  it('persists the choice and reads it back after a reload', async () => {
    const m = await load();
    m.setListeningService('youtube');
    expect(window.localStorage.getItem(m.LISTENING_SERVICE_KEY)).toBe('youtube');
    const again = await load();
    expect(again.getListeningService()).toBe('youtube');
  });

  it('ignores an invalid stored value', async () => {
    window.localStorage.setItem('cojam.listeningService', 'deezer');
    const m = await load();
    expect(m.getListeningService()).toBe('auto');
  });

  it('survives blocked storage', async () => {
    const m = await load();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => m.setListeningService('apple')).not.toThrow();
    expect(m.getListeningService()).toBe('apple');
    spy.mockRestore();
  });
});
