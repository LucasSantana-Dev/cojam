// The "Ouvir no" preference: which service plays the room for THIS person.
// Global across rooms, kept in localStorage. External store read with
// useSyncExternalStore so SSR and the first client render agree on 'auto' and
// the saved choice is adopted right after hydration.
import { useSyncExternalStore } from 'react';
import type { ServicePreference } from './pickSource';
import { trackEvent } from './telemetry';

export const LISTENING_SERVICE_KEY = 'cojam.listeningService';

// A stored value outside this list (e.g. 'apple', saved before Apple Music was
// removed on 2026-10-08) reads as 'auto'.
const VALID: readonly ServicePreference[] = ['auto', 'spotify', 'youtube'];

function isPreference(v: unknown): v is ServicePreference {
  return typeof v === 'string' && (VALID as readonly string[]).includes(v);
}

let current: ServicePreference | null = null;
const listeners = new Set<() => void>();

function readStored(): ServicePreference {
  try {
    const raw = window.localStorage.getItem(LISTENING_SERVICE_KEY);
    return isPreference(raw) ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

export function getListeningService(): ServicePreference {
  if (typeof window === 'undefined') return 'auto';
  if (current === null) current = readStored();
  return current;
}

export function setListeningService(next: ServicePreference): void {
  if (!isPreference(next)) return;
  const changed = getListeningService() !== next;
  current = next;
  // An explicit switch to a service is the "provider connected" funnel step.
  if (changed && next !== 'auto') trackEvent('provider_connected');
  try {
    window.localStorage.setItem(LISTENING_SERVICE_KEY, next);
  } catch {
    /* private mode or blocked storage: the choice lasts for this page load */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== LISTENING_SERVICE_KEY) return;
    current = readStored();
    cb();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

export function useListeningService(): ServicePreference {
  return useSyncExternalStore(subscribe, getListeningService, () => 'auto');
}
