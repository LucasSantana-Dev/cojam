// Per-person LOCAL listening volume and mute. Never sent to the server: it is
// not a transport control, so every member (host or not) owns their own level.
// Kept in localStorage; one external store read with useSyncExternalStore so
// SSR and the first client render agree on the default and the saved level is
// adopted right after hydration.
import { useEffect, useSyncExternalStore } from 'react';
import type { IPlayer } from './playerInterface';

export const VOLUME_KEY = 'cojam.volume';

export interface VolumeState {
  // 0..1
  level: number;
  muted: boolean;
}

const DEFAULT: VolumeState = { level: 0.8, muted: false };

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT.level;
}

function parse(raw: string | null): VolumeState {
  if (!raw) return DEFAULT;
  try {
    const v = JSON.parse(raw) as Partial<VolumeState>;
    return { level: clamp01(typeof v.level === 'number' ? v.level : DEFAULT.level), muted: v.muted === true };
  } catch {
    return DEFAULT;
  }
}

let current: VolumeState | null = null;
const listeners = new Set<() => void>();

function readStored(): VolumeState {
  try {
    return parse(window.localStorage.getItem(VOLUME_KEY));
  } catch {
    return DEFAULT;
  }
}

export function getVolume(): VolumeState {
  if (typeof window === 'undefined') return DEFAULT;
  if (current === null) current = readStored();
  return current;
}

export function setVolume(next: Partial<VolumeState>): void {
  const prev = getVolume();
  const merged: VolumeState = {
    level: next.level === undefined ? prev.level : clamp01(next.level),
    muted: next.muted === undefined ? prev.muted : next.muted,
  };
  current = merged;
  try {
    window.localStorage.setItem(VOLUME_KEY, JSON.stringify(merged));
  } catch {
    /* private mode or blocked storage: the level lasts for this page load */
  }
  listeners.forEach((l) => l());
}

// What the player should be set to: 0 while muted, else the saved level.
export function effectiveVolume(v: VolumeState): number {
  return v.muted ? 0 : v.level;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== VOLUME_KEY) return;
    current = readStored();
    cb();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

export function useVolume(): VolumeState {
  return useSyncExternalStore(subscribe, getVolume, () => DEFAULT);
}

// Applies the saved level to the active player now and whenever the player (a
// mount, an "Ouvir no" switch) or the level changes, so a new player never
// starts at its own default.
export function useApplyVolume(player: IPlayer | null): void {
  const level = effectiveVolume(useVolume());
  useEffect(() => {
    player?.setVolume?.(level);
  }, [player, level]);
}
