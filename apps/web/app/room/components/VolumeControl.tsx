'use client';

// Local volume and mute for whichever player is active. Not a transport
// control: not gated by canControl or the sync flag, and never sent anywhere.
import { setVolume, useVolume } from '@/lib/volume';

export function VolumeControl() {
  const { level, muted } = useVolume();
  const shown = muted ? 0 : level;
  return (
    <div className="r4-vol">
      <button
        type="button"
        className="r4-vol__mute"
        aria-pressed={muted}
        aria-label="Silenciar"
        title={muted ? 'Ativar o som' : 'Silenciar'}
        onClick={() => setVolume({ muted: !muted })}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M3 9v6h4l5 5V4L7 9H3z" />
          {muted ? (
            <path d="M15.3 9.3 21 15M21 9.3 15.3 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          ) : (
            <path d="M16.5 12A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z" />
          )}
        </svg>
      </button>
      <input
        type="range"
        className="r4-vol__range"
        aria-label="Volume"
        min={0}
        max={100}
        step={1}
        value={Math.round(shown * 100)}
        aria-valuetext={`${Math.round(shown * 100)}%`}
        onChange={(e) => setVolume({ level: Number(e.target.value) / 100, muted: false })}
        style={{ ['--pct' as string]: `${Math.round(shown * 100)}%` }}
      />
    </div>
  );
}
