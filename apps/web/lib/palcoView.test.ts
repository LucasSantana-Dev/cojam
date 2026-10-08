import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { PALCO_VIEW_KEY, PALCO_MOTION_KEY, getPalcoView, setPalcoView, usePalcoView, usePalcoMotion, setPalcoMotion, resetPalcoPrefs } from './palcoView';

describe('modo palco preferences', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetPalcoPrefs();
  });

  it('defaults to the round 4 room with motion on', () => {
    expect(getPalcoView()).toBe(false);
    expect(renderHook(() => usePalcoMotion()).result.current).toBe(true);
  });

  it('remembers the view in localStorage and tells subscribers', () => {
    const { result } = renderHook(() => usePalcoView());
    act(() => setPalcoView(true));
    expect(result.current).toBe(true);
    expect(window.localStorage.getItem(PALCO_VIEW_KEY)).toBe('1');
    resetPalcoPrefs();
    expect(getPalcoView()).toBe(true);
    act(() => setPalcoMotion(false));
    expect(window.localStorage.getItem(PALCO_MOTION_KEY)).toBe('0');
  });

  it('survives blocked storage for the page load', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(getPalcoView()).toBe(false);
    setPalcoView(true);
    expect(getPalcoView()).toBe(true);
    get.mockRestore();
    set.mockRestore();
  });
});
