// Modo palco preferences, kept in this browser (localStorage): which room view
// is on ("Modo palco" toggle in the top bar, the round 4 room is the default)
// and the in-scene "Movimento" toggle. Both are per viewer conveniences, never
// sent to the server. Reads survive blocked storage (the default applies).
import { useSyncExternalStore } from 'react';

export const PALCO_VIEW_KEY = 'cojam.palco.view';
export const PALCO_MOTION_KEY = 'cojam.palco.motion';

function makeFlag(key: string, fallback: boolean) {
  let current: boolean | undefined;
  const listeners = new Set<() => void>();
  const read = (): boolean => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : raw === '1';
    } catch {
      return fallback;
    }
  };
  const get = (): boolean => {
    if (typeof window === 'undefined') return fallback;
    if (current === undefined) current = read();
    return current;
  };
  const set = (v: boolean): void => {
    current = v;
    try {
      window.localStorage.setItem(key, v ? '1' : '0');
    } catch {
      /* blocked storage: the choice lasts for this page load */
    }
    listeners.forEach((l) => l());
  };
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      current = read();
      cb();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(cb);
      window.removeEventListener('storage', onStorage);
    };
  };
  const reset = () => {
    current = undefined;
  };
  // Server and first client render use the default: no hydration mismatch.
  const use = (): boolean => useSyncExternalStore(subscribe, get, () => fallback);
  return { get, set, use, reset };
}

const view = makeFlag(PALCO_VIEW_KEY, false);
const motion = makeFlag(PALCO_MOTION_KEY, true);

export const usePalcoView = view.use;
export const setPalcoView = view.set;
export const getPalcoView = view.get;
export const usePalcoMotion = motion.use;
export const setPalcoMotion = motion.set;

// Test hook: forget the cached reads.
export function resetPalcoPrefs(): void {
  view.reset();
  motion.reset();
}
