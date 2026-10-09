'use client';

import { useEffect, useState } from 'react';

// "04h" or "04h30": the local time the YouTube search quota comes back. The
// server sends the reset instant (unix ms, midnight Pacific); the hour is
// worked out here so it is right in every time zone.
export function quotaResetLabel(until: number): string {
  const d = new Date(until);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = d.getMinutes();
  return mm === 0 ? `${hh}h` : `${hh}h${String(mm).padStart(2, '0')}`;
}

// Shown while the server's daily YouTube search quota is spent: new tracks get
// no YouTube source until it resets. Hides itself at the reset time.
export function YouTubeQuotaNote({ until, now = Date.now }: { until?: number; now?: () => number }) {
  const [, tick] = useState(0);
  const active = typeof until === 'number' && until > now();

  useEffect(() => {
    if (!active || typeof until !== 'number') return;
    // setTimeout overflows past ~24.8 days; the reset is at most a day away.
    const t = setTimeout(() => tick((n) => n + 1), Math.max(0, until - now()) + 50);
    return () => clearTimeout(t);
  }, [active, until, now]);

  if (!active || typeof until !== 'number') return null;
  return (
    <p className="r4-service__note" role="status" data-testid="youtube-quota-note">
      Busca do YouTube esgotada hoje. Volta às {quotaResetLabel(until)}.
    </p>
  );
}
