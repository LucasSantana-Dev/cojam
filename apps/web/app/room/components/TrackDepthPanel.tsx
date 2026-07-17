'use client';

import { useState, useEffect, useRef } from 'react';
import type { TrackRef } from '@cojam/shared';
import { fetchTrackDepth } from '@/lib/realtime';

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
        className="track-depth-backdrop fixed inset-0 bg-black/50 opacity-0 pointer-events-none transition-opacity duration-200 lg:hidden"
        style={{
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          zIndex: open ? 40 : -1,
        }}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className="track-depth-panel fixed bottom-0 left-0 right-0 lg:fixed lg:bottom-auto lg:right-0 lg:top-0 lg:max-w-sm h-screen lg:h-auto max-h-[90vh] lg:max-h-screen panel flex flex-col bg-clip-padding border border-solid transition-all duration-200"
        style={{
          backgroundColor: 'var(--color-surface-1)',
          borderColor: 'var(--color-border)',
          transform: open
            ? 'translateX(0) translateY(0)'
            : 'translateY(100%) translateX(0)',
          zIndex: open ? 50 : -1,
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
