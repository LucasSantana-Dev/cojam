// Motion moments for the sintonia look (#325): the pinned scroll story, the
// section wave, the cover flip and the drifting ground.
// prefers-reduced-motion turns every moment off except `wave`, which stays
// visible as a static, fully drawn line (the final state, no animation).
import { useSyncExternalStore } from 'react';

export type MotionState = { scrollstory: boolean; wave: boolean; flip: boolean; ground: boolean; reduced: boolean };

const NONE: MotionState = { scrollstory: false, wave: false, flip: false, ground: false, reduced: false };
const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

export function parseMotion(reduced: boolean): MotionState {
  return {
    scrollstory: !reduced,
    flip: !reduced,
    // the ground drifts, pulses and breathes; reduced shows one static frame
    ground: !reduced,
    // visible even when reduced: it renders already drawn
    wave: true,
    reduced,
  };
}

// matchMedia is absent in some test environments: treat that as no preference
const reducedList = () => (typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_QUERY) : null);

function subscribe(cb: () => void) {
  const mq = reducedList();
  mq?.addEventListener('change', cb);
  return () => mq?.removeEventListener('change', cb);
}
const snapshot = () => (reducedList()?.matches ? 'reduced' : 'full');

/** Server and first client render are the static baseline; motion enhances after hydration. */
export function useMotion(): MotionState {
  const snap = useSyncExternalStore(subscribe, snapshot, () => '');
  if (!snap) return NONE;
  return parseMotion(snap === 'reduced');
}
