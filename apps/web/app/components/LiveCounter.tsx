'use client';

import { useEffect, useState } from 'react';
import { fetchLiveStats, type LiveStats } from '@/lib/liveStats';

const POLL_MS = 30_000;

// LiveCounter shows "N people in M rooms right now". Hidden when nobody is in
// a room, and on any fetch failure: an honest zero is not worth advertising.
export function LiveCounter() {
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
    <p className="live-counter" role="status">
      <span className="room-card__dot" aria-hidden />
      {stats.people} {stats.people === 1 ? 'pessoa' : 'pessoas'} em{' '}
      {stats.rooms} {stats.rooms === 1 ? 'sala' : 'salas'} agora
    </p>
  );
}
