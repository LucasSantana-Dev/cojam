import { useEffect, useState } from 'react';
import { DEMO_CYCLE_MS, DEMO_TRACKS } from './demoTracks';
import { useMotion } from './motionFlags';

/** Index of the demo track on stage. Advances slowly; frozen under prefers-reduced-motion, live to preference changes. */
export function useDemoCycle(intervalMs: number = DEMO_CYCLE_MS): number {
  const [i, setI] = useState(0);
  const { reduced } = useMotion();
  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => setI((n) => (n + 1) % DEMO_TRACKS.length), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, reduced]);
  return i;
}
