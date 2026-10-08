import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { IPlayer } from './playerInterface';

async function load() {
  vi.resetModules();
  return import('./volume');
}

const fakePlayer = () => ({ setVolume: vi.fn() }) as unknown as IPlayer & { setVolume: ReturnType<typeof vi.fn> };

describe('local volume', () => {
  beforeEach(() => window.localStorage.clear());

  it('defaults to 80% unmuted', async () => {
    const m = await load();
    expect(m.getVolume()).toEqual({ level: 0.8, muted: false });
  });

  it('persists level and mute across a reload', async () => {
    const m = await load();
    m.setVolume({ level: 0.3 });
    m.setVolume({ muted: true });
    const again = await load();
    expect(again.getVolume()).toEqual({ level: 0.3, muted: true });
    expect(again.effectiveVolume(again.getVolume())).toBe(0);
  });

  it('clamps and ignores corrupt storage', async () => {
    const m = await load();
    m.setVolume({ level: 7 });
    expect(m.getVolume().level).toBe(1);
    window.localStorage.setItem('cojam.volume', '{nope');
    const again = await load();
    expect(again.getVolume()).toEqual({ level: 0.8, muted: false });
  });

  it('survives blocked storage', async () => {
    const m = await load();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => m.setVolume({ level: 0.5 })).not.toThrow();
    expect(m.getVolume().level).toBe(0.5);
    spy.mockRestore();
  });

  it('the active player receives the saved level, then every change', async () => {
    window.localStorage.setItem('cojam.volume', JSON.stringify({ level: 0.4, muted: false }));
    const m = await load();
    const p = fakePlayer();
    renderHook(() => m.useApplyVolume(p));
    expect(p.setVolume).toHaveBeenLastCalledWith(0.4);
    act(() => m.setVolume({ level: 0.9 }));
    expect(p.setVolume).toHaveBeenLastCalledWith(0.9);
    act(() => m.setVolume({ muted: true }));
    expect(p.setVolume).toHaveBeenLastCalledWith(0);
  });

  it('a new player (service switch) gets the level on mount', async () => {
    const m = await load();
    m.setVolume({ level: 0.25 });
    const a = fakePlayer();
    const b = fakePlayer();
    const { rerender } = renderHook(({ p }) => m.useApplyVolume(p), { initialProps: { p: a as IPlayer | null } });
    rerender({ p: b });
    expect(b.setVolume).toHaveBeenCalledWith(0.25);
  });

  it('does nothing without a player or without setVolume', async () => {
    const m = await load();
    expect(() => renderHook(() => m.useApplyVolume(null))).not.toThrow();
    expect(() => renderHook(() => m.useApplyVolume({} as IPlayer))).not.toThrow();
  });
});
