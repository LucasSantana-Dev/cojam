// Audience characters ("Modo palco"): a fixed roster of 12, ids 1..12, repeats
// allowed. The wire carries only the id (packages/shared protocol.ts); the art
// lives in public/palco/characters. Render it with integer scaling and
// image-rendering: pixelated only.
import { useSyncExternalStore } from 'react';
import { CHARACTER_COUNT } from '@cojam/shared';

export { CHARACTER_COUNT };

export const CHARACTER_KEY = 'cojam.character';

// Accessible names, in roster order (docs/design/modo-palco.md section 7).
export const CHARACTER_LABELS: readonly string[] = [
  'Cabelo castanho e moletom azul',
  'Cabelo afro e camiseta vermelha',
  'Homem calvo de óculos e camisa florida',
  'Hijab verde e jaqueta jeans',
  'Tranças longas e regata verde',
  'Cabelo cacheado, óculos e suéter amarelo',
  'Cabeça raspada e fones roxos',
  'Coque e vestido estampado',
  'Cabelo cacheado, óculos e moletom cinza',
  'Undercut e camiseta listrada',
  'Cabelos grisalhos cacheados e cardigã bege',
  'Boné, dreads e cadeira de rodas',
];

export function isCharacterId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= CHARACTER_COUNT;
}

// FNV-1a 32 bit of the UTF-8 bytes, mod 12, plus 1. Same function as the
// server's DefaultCharacter (apps/server/internal/hub/character.go); both are
// pinned by the same test vectors.
export function defaultCharacterId(seed: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(seed)) {
    h = Math.imul(h ^ b, 0x01000193) >>> 0;
  }
  return (h % CHARACTER_COUNT) + 1;
}

const pad = (id: number) => String(id).padStart(2, '0');
export const portraitSrc = (id: number) => `/palco/characters/${pad(id)}-portrait.png`;
export const frontSrc = (id: number) => `/palco/characters/${pad(id)}-front.png`;
export const backSrc = (id: number) => `/palco/characters/${pad(id)}-back.png`;

// --- This person's own choice: global across rooms, kept in localStorage. ---
let current: number | null | undefined; // undefined = not read yet
const listeners = new Set<() => void>();

function readStored(): number | null {
  try {
    const raw = window.localStorage.getItem(CHARACTER_KEY);
    const n = raw === null ? NaN : Number(raw);
    return isCharacterId(n) ? n : null;
  } catch {
    return null;
  }
}

// null = never chose (the default hash applies).
export function getStoredCharacter(): number | null {
  if (typeof window === 'undefined') return null;
  if (current === undefined) current = readStored();
  return current;
}

export function setStoredCharacter(id: number): void {
  if (!isCharacterId(id)) return;
  current = id;
  try {
    window.localStorage.setItem(CHARACTER_KEY, String(id));
  } catch {
    /* private mode or blocked storage: the choice lasts for this page load */
  }
  listeners.forEach((l) => l());
}

// Test hook: forget the cached read so the next get reads storage again.
export function resetCharacterCache(): void {
  current = undefined;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== CHARACTER_KEY) return;
    current = readStored();
    cb();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

export function useStoredCharacter(): number | null {
  return useSyncExternalStore(subscribe, getStoredCharacter, () => null);
}

// The character a member is shown with: their choice, else the stable default
// from the userId (the clientId for entries without one).
export function memberCharacter(m: { characterId?: number; userId?: string; clientId: string }): number {
  return isCharacterId(m.characterId) ? m.characterId : defaultCharacterId(m.userId ?? m.clientId);
}
