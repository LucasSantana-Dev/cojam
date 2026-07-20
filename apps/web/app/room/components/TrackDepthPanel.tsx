'use client';

import { useState, useEffect, useRef } from 'react';
import type { TrackRef } from '@cojam/shared';
import { fetchTrackDepth } from '@/lib/realtime';
import { formatTime } from './TransportUI';

interface TrackDepthPanelProps {
  roomId: string;
  track: TrackRef | null;
  open: boolean;
  onClose: () => void;
}

export function TrackDepthPanel({ roomId, track, open, onClose }: TrackDepthPanelProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
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
        const result = await fetchTrackDepth(roomId, track.isrc || '', track.title, track.artist);
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch track details');
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
        className="track-depth-backdrop lg:hidden"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      {/* Mount-gated: enter animation lives in globals.css (sheet-up on mobile,
          side-in on desktop); breakpoint owns the direction, not inline style. */}
      <div
        className="track-depth-panel panel flex flex-col"
        style={{
          backgroundColor: 'var(--color-surface-1)',
          borderColor: 'var(--color-border)',
        }}
      >
        {/* Header */}
        <div className="flex-shrink-0 px-6 py-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-accent)', letterSpacing: '0.15em' }}>
                Track Depth
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
              aria-label="Close track details"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
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
            </div>
          )}

          {/* Metadata rail (R8): mono LABEL / value pairs from data the room
              already has, so it renders even while the fetch is in flight. */}
          <dl className="meta-rail">
            <div className="meta-rail__row">
              <dt>ISRC</dt>
              <dd>{track.isrc || 'Unknown'}</dd>
            </div>
            <div className="meta-rail__row">
              <dt>Duration</dt>
              <dd>{track.durationMs ? formatTime(track.durationMs) : 'Unknown'}</dd>
            </div>
            <div className="meta-rail__row">
              <dt>Added by</dt>
              <dd>{track.addedBy}</dd>
            </div>
            <div className="meta-rail__row">
              <dt>Services</dt>
              <dd>
                {(['youtube', 'spotify', 'apple'] as const)
                  .filter((s) => track.sources[s])
                  .map((s) => (s === 'youtube' ? 'YouTube' : s === 'spotify' ? 'Spotify' : 'Apple'))
                  .join(' · ') || 'None'}
              </dd>
            </div>
          </dl>

          {data && !loading && (
            <>
              {/* Credits */}
              {data.credits && data.credits.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold mb-2 uppercase" style={{ color: 'var(--color-accent)', letterSpacing: '0.05em' }}>
                    Credits
                  </h3>
                  <div className="space-y-2">
                    {data.credits.map((credit: any, idx: number) => (
                      <div key={idx} className="flex gap-3">
                        <span className="text-xs uppercase font-medium flex-shrink-0 w-16" style={{ color: 'var(--color-text-secondary)' }}>
                          {credit.role}
                        </span>
                        <span style={{ color: 'var(--color-text-primary)' }}>{credit.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Release Info */}
              {(data.releaseYear || data.label) && (
                <div>
                  <h3 className="text-sm font-semibold mb-2 uppercase" style={{ color: 'var(--color-accent)', letterSpacing: '0.05em' }}>
                    Release
                  </h3>
                  <div className="space-y-1 text-sm">
                    {data.releaseYear && (
                      <p style={{ color: 'var(--color-text-primary)' }}>
                        <span style={{ color: 'var(--color-text-secondary)' }}>Year: </span>
                        {data.releaseYear}
                      </p>
                    )}
                    {data.label && (
                      <p style={{ color: 'var(--color-text-primary)' }}>
                        <span style={{ color: 'var(--color-text-secondary)' }}>Label: </span>
                        {data.label}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Tags */}
              {data.tags && data.tags.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold mb-2 uppercase" style={{ color: 'var(--color-accent)', letterSpacing: '0.05em' }}>
                    Tags
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {data.tags.slice(0, 8).map((tag: string, idx: number) => (
                      <span
                        key={idx}
                        className="px-2 py-1 rounded text-xs font-medium"
                        style={{ backgroundColor: 'var(--color-surface-2)', color: 'var(--color-text-primary)' }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* No data state */}
              {(!data.credits || data.credits.length === 0) && !data.releaseYear && !data.label && (!data.tags || data.tags.length === 0) && (
                <div style={{ color: 'var(--color-text-secondary)' }}>
                  <p className="text-sm">No deeper data for this track yet.</p>
                </div>
              )}

              {/* Source attribution */}
              <div className="pt-2 border-t" style={{ borderColor: 'var(--color-border)' }}>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  Data from MusicBrainz
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
