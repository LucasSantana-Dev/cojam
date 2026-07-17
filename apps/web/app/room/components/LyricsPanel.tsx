'use client';

import { useState, useEffect, useRef } from 'react';
import type { TrackRef } from '@cojam/shared';
import { fetchLyrics } from '@/lib/realtime';

interface LyricsPanelProps {
  roomId: string;
  track: TrackRef | null;
  open: boolean;
  onClose: () => void;
}

export function LyricsPanel({ roomId, track, open, onClose }: LyricsPanelProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open || !track) {
      setData(null);
      setError(null);
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchLyrics(
          roomId,
          track.artist,
          track.title,
          undefined,
          track.durationMs || undefined
        );
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch lyrics');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [open, track, roomId]);

  // Close on Esc
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open || !track) return null;

  return (
    <>
      {/* Backdrop (mobile + close on click) */}
      <div
        className="lyrics-backdrop lg:hidden"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className="lyrics-panel panel flex flex-col"
        style={{
          backgroundColor: 'var(--color-surface-1)',
          borderColor: 'var(--color-border)',
        }}
        ref={containerRef}
      >
        {/* Header */}
        <div className="flex-shrink-0 px-6 py-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-accent)', letterSpacing: '0.15em' }}>
                Lyrics
              </p>
              <h2 className="text-lg font-semibold mt-1 truncate" style={{ color: 'var(--color-text-primary)' }}>
                {track.title}
              </h2>
              <p className="text-sm truncate" style={{ color: 'var(--color-text-secondary)' }}>
                {track.artist}
              </p>
            </div>
            <button
              onClick={onClose}
              className="flex-shrink-0 p-2 rounded-lg hover:opacity-70 transition-opacity"
              style={{ backgroundColor: 'var(--color-surface-2)', color: 'var(--color-text-primary)' }}
              aria-label="Close lyrics"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {loading && (
            <div className="space-y-3">
              <div className="h-4 bg-gray-300 rounded animate-pulse" style={{ backgroundColor: 'var(--color-surface-2)' }} />
              <div className="h-4 bg-gray-300 rounded animate-pulse w-5/6" style={{ backgroundColor: 'var(--color-surface-2)' }} />
              <div className="h-4 bg-gray-300 rounded animate-pulse w-4/6" style={{ backgroundColor: 'var(--color-surface-2)' }} />
            </div>
          )}

          {error && (
            <div className="rounded-lg p-3 text-sm" style={{ backgroundColor: 'var(--color-surface-2)', color: 'var(--color-text-secondary)' }}>
              <p>{error}</p>
              <button
                onClick={() => {
                  setError(null);
                  setData(null);
                }}
                className="mt-2 text-xs underline hover:opacity-70 transition-opacity"
                style={{ color: 'var(--color-accent)' }}
              >
                Retry
              </button>
            </div>
          )}

          {data && !loading && (
            <>
              {/* Synced lyrics (if available) */}
              {data.synced && data.synced.length > 0 ? (
                <div className="space-y-2">
                  {data.synced.map((line: any, idx: number) => (
                    <div
                      key={idx}
                      className="py-2 px-3 rounded text-sm transition-all duration-150"
                      style={{
                        backgroundColor: 'var(--color-surface-2)',
                        color: 'var(--color-text-primary)',
                      }}
                    >
                      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                        {Math.floor(line.timeMs / 60000)}:{String(Math.floor((line.timeMs % 60000) / 1000)).padStart(2, '0')}
                      </span>
                      <span className="ml-3">{line.text}</span>
                    </div>
                  ))}
                </div>
              ) : data.plain ? (
                <div
                  className="p-4 rounded-lg whitespace-pre-wrap text-sm leading-relaxed"
                  style={{
                    backgroundColor: 'var(--color-surface-2)',
                    color: 'var(--color-text-primary)',
                  }}
                >
                  {data.plain}
                </div>
              ) : (
                <div style={{ color: 'var(--color-text-secondary)' }}>
                  <p className="text-sm">No lyrics found for this track yet.</p>
                </div>
              )}

              {/* Source attribution */}
              <div className="pt-2 border-t text-xs" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
                Data from LRCLIB
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
