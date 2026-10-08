'use client';

import { useEffect, useState } from 'react';
import { fetchLiveStats, type LiveStats } from '@/lib/liveStats';

const POLL_MS = 30_000;

// LiveCounter shows "N people in M rooms right now". Hidden when nobody is in
// a room, and on any fetch failure: an honest zero is not worth advertising.
export function LiveCounter({ pill = false, className = '' }: { pill?: boolean; className?: string }) {
  const [stats, setStats] = useState<LiveStats | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const next = await fetchLiveStats(controller.signal);
      if (!controller.signal.aborted) setStats(next);
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  if (!stats || stats.people <= 0) return null;
  return (
    <p className={`live-counter ${className}`.trim()} role="status">
      {pill ? (
        <span className="r4-live">
          <span className="r4-live__dot" aria-hidden />
          AO VIVO
        </span>
      ) : (
        <span className="room-card__dot" aria-hidden />
      )}
      {stats.people} {stats.people === 1 ? 'pessoa' : 'pessoas'} em{' '}
      {stats.rooms} {stats.rooms === 1 ? 'sala' : 'salas'} agora
    </p>
  );
}
