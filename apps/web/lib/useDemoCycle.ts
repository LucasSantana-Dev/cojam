import { useEffect, useState } from 'react';
import { DEMO_CYCLE_MS, DEMO_TRACKS } from './demoTracks';

/** Index of the demo track on stage. Advances slowly; frozen under prefers-reduced-motion. */
export function useDemoCycle(intervalMs: number = DEMO_CYCLE_MS): number {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => setI((n) => (n + 1) % DEMO_TRACKS.length), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return i;
}
