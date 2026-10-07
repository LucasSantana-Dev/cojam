// Client hooks for the brand axes (see brandAxesConfig.ts for the contract).
// Components read the attribute through useAxis, whose server snapshot is the
// default so SSR and the first client render agree.
import { useSyncExternalStore } from 'react';
import { AXIS_DEFAULTS, STORAGE_KEY, type AxisName, type AxisValue } from './brandAxesConfig';

type Listener = () => void;
const listeners = new Set<Listener>();

export function setAxis<A extends AxisName>(axis: A, value: AxisValue<A> | 'default'): void {
  const el = document.documentElement;
  el.setAttribute(`data-${axis}`, value);
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const stored = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    stored[axis] = value;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    const url = new URL(window.location.href);
    url.searchParams.set(axis, value);
    window.history.replaceState(null, '', url);
  } catch {
    /* storage or history unavailable: the attribute still applies */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useAxis<A extends AxisName>(axis: A): string {
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.getAttribute(`data-${axis}`) ?? AXIS_DEFAULTS[axis],
    () => AXIS_DEFAULTS[axis],
  );
}

export function usePreviewMode(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.getAttribute('data-preview') === '1',
    () => false,
  );
}
