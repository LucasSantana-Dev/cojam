'use client';

import { useEffect, useState } from 'react';
import { useStore, getClockOffsetMs } from '@/lib/realtime';
import { formatRelativeTime } from '@/lib/relativeTime';

// Recent queue adds, newest first. Honest-data lock: only server-stamped
// TrackRef.addedAt is shown, corrected by the measured clock offset
// (sync.ping); tracks from before the server stamped timestamps are skipped,
// and a room with no stamped adds renders nothing at all.
const MAX_ENTRIES = 5;
// Relative labels go stale without new state; re-render on a slow tick.
const REFRESH_MS = 30_000;

function addedAgo(addedAt: number): string {
  return formatRelativeTime(addedAt, Date.now() + getClockOffsetMs()) ?? '';
}

export function ActivityRail() {
  const queue = useStore((s) => s.state?.queue);
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const entries = (queue ?? [])
    .flatMap((t) => (t.addedAt ? [{ track: t, addedAt: t.addedAt }] : []))
    .sort((a, b) => b.addedAt - a.addedAt)
    .slice(0, MAX_ENTRIES);

  if (entries.length === 0) return null;

  return (
    <div className="panel p-6 space-y-4 mt-6">
      <div>
        <h3 className="text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          Activity
        </h3>
      </div>
      <ul className="space-y-3">
        {entries.map(({ track, addedAt }) => (
          <li key={track.id} className="flex items-baseline gap-2">
            <p className="flex-1 min-w-0 truncate text-sm" style={{ color: 'var(--color-text-primary)' }}>
              <span className="font-semibold">{track.addedBy}</span>
              <span style={{ color: 'var(--color-text-secondary)' }}> added {track.title}</span>
            </p>
            <span className="text-xs flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
              {addedAgo(addedAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
