'use client';

import { useState, useEffect, useRef } from 'react';
import type { TrackRef } from '@cojam/shared';
import { fetchListenBrainz, fetchLastfmEnrich, type ListenBrainzEnrichment, type LastfmEnrich } from '@/lib/realtime';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import { useDialogFocus } from './useDialogFocus';

interface EnrichmentPanelProps {
  roomId: string;
  track: TrackRef | null;
  open: boolean;
  onClose: () => void;
}

// Format large numbers as compact strings (e.g. 1200000 -> "1.2M")
function formatCount(num: number): string {
  if (num < 1000) return num.toString();
  if (num < 1000000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}

export function EnrichmentPanel({ roomId, track, open, onClose }: EnrichmentPanelProps) {
  const f = useRuntimeFeatures();
  // ListenBrainz section state
  const [lbLoading, setLbLoading] = useState(false);
  const [lbError, setLbError] = useState<string | null>(null);
  const [lbData, setLbData] = useState<ListenBrainzEnrichment | null>(null);

  // Last.fm section state
  const [lfmLoading, setLfmLoading] = useState(false);
  const [lfmError, setLfmError] = useState<string | null>(null);
  const [lfmData, setLfmData] = useState<LastfmEnrich | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  useDialogFocus(open, onClose, containerRef);

  // Panel stays mounted while closed; reset loaded data when the open/track
  // key changes (docs-sanctioned state adjustment during render).
  const trackKey = open && track ? track.id : null;
  const [prevTrackKey, setPrevTrackKey] = useState(trackKey);
  if (trackKey !== prevTrackKey) {
    setPrevTrackKey(trackKey);
    setLbData(null);
    setLbError(null);
    setLfmData(null);
    setLfmError(null);
  }

  // Fetch data when panel opens. The cleanup flag drops stale responses: a
  // fetch for the previous track must not repopulate the panel after a
  // track change (or after close).
  useEffect(() => {
    if (!open || !track) {
      return;
    }
    let cancelled = false;

    // Fetch ListenBrainz if enabled
    if (f.listenBrainz) {
      const fetchLb = async () => {
        setLbLoading(true);
        setLbError(null);
        try {
          const result = await fetchListenBrainz(roomId, track.isrc || '', track.title, track.artist);
          if (!cancelled) setLbData(result);
        } catch (err) {
          if (!cancelled) setLbError(err instanceof Error ? err.message : 'Failed to fetch ListenBrainz data');
        } finally {
          if (!cancelled) setLbLoading(false);
        }
      };
      fetchLb();
    }

    // Fetch Last.fm if enabled
    if (f.lastfmEnrich) {
      const fetchLfm = async () => {
        setLfmLoading(true);
        setLfmError(null);
        try {
          const result = await fetchLastfmEnrich(roomId, track.artist, track.title);
          if (!cancelled) setLfmData(result);
        } catch (err) {
          if (!cancelled) setLfmError(err instanceof Error ? err.message : 'Failed to fetch Last.fm data');
        } finally {
          if (!cancelled) setLfmLoading(false);
        }
      };
      fetchLfm();
    }

    return () => {
      cancelled = true;
    };
  }, [open, track, roomId, f.listenBrainz, f.lastfmEnrich]);

  if (!open || !track) return null;

  // Don't show panel at all if both providers are disabled
  if (!f.listenBrainz && !f.lastfmEnrich) return null;

  return (
    <>
      {/* Backdrop (mobile + close on click) */}
      <div
        className="enrichment-backdrop lg:hidden"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className="enrichment-panel panel flex flex-col"
        style={{
          backgroundColor: 'var(--color-surface-1)',
          borderColor: 'var(--color-border)',
        }}
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Enrichment for ${track.title}`}
      >
        {/* Header */}
        <div className="flex-shrink-0 px-6 py-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-accent)', letterSpacing: '0.15em' }}>
                Enrichment
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
              aria-label="Close enrichment panel"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* ListenBrainz Section */}
          {f.listenBrainz && (
            <div>
              <h3 className="text-sm font-semibold mb-3 uppercase" style={{ color: 'var(--color-accent)', letterSpacing: '0.05em' }}>
                ListenBrainz
              </h3>

              {lbLoading && (
                <div className="space-y-2">
                  <div className="h-4 bg-gray-300 rounded animate-pulse" style={{ backgroundColor: 'var(--color-surface-2)' }} />
                  <div className="h-4 bg-gray-300 rounded animate-pulse w-5/6" style={{ backgroundColor: 'var(--color-surface-2)' }} />
                </div>
              )}

              {lbError && (
                <div className="rounded-lg p-3 text-sm" style={{ backgroundColor: 'var(--color-surface-2)', color: 'var(--color-text-secondary)' }}>
                  <p>{lbError}</p>
                </div>
              )}

              {lbData && !lbLoading && (
                <div className="space-y-3">
                  {lbData.count !== undefined && (
                    <div className="flex gap-2 items-center">
                      <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                        Play count:
                      </span>
                      <span style={{ color: 'var(--color-text-primary)' }}>
                        {formatCount(lbData.count)}
                      </span>
                    </div>
                  )}

                  {lbData.tags && lbData.tags.length > 0 && (
                    <div>
                      <p className="text-xs font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                        Tags
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {lbData.tags.slice(0, 6).map((tag: string, idx: number) => (
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

                  {(!lbData.tags || lbData.tags.length === 0) && lbData.count === undefined && (
                    <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                      No additional data available.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Last.fm Section */}
          {f.lastfmEnrich && (
            <div>
              <h3 className="text-sm font-semibold mb-3 uppercase" style={{ color: 'var(--color-accent)', letterSpacing: '0.05em' }}>
                Last.fm
              </h3>

              {lfmLoading && (
                <div className="space-y-2">
                  <div className="h-4 bg-gray-300 rounded animate-pulse" style={{ backgroundColor: 'var(--color-surface-2)' }} />
                  <div className="h-4 bg-gray-300 rounded animate-pulse w-5/6" style={{ backgroundColor: 'var(--color-surface-2)' }} />
                </div>
              )}

              {lfmError && (
                <div className="rounded-lg p-3 text-sm" style={{ backgroundColor: 'var(--color-surface-2)', color: 'var(--color-text-secondary)' }}>
                  <p>{lfmError}</p>
                </div>
              )}

              {lfmData && !lfmLoading && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                        Play count
                      </p>
                      <p className="text-lg font-semibold mt-1" style={{ color: 'var(--color-text-primary)' }}>
                        {formatCount(lfmData.playcount)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                        Listeners
                      </p>
                      <p className="text-lg font-semibold mt-1" style={{ color: 'var(--color-text-primary)' }}>
                        {formatCount(lfmData.listeners)}
                      </p>
                    </div>
                  </div>

                  {lfmData.tags && lfmData.tags.length > 0 && (
                    <div>
                      <p className="text-xs font-medium mb-2" style={{ color: 'var(--color-text-secondary)' }}>
                        Tags
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {lfmData.tags.slice(0, 6).map((tag: string, idx: number) => (
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

                  {(!lfmData.tags || lfmData.tags.length === 0) && lfmData.playcount === 0 && lfmData.listeners === 0 && (
                    <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                      No data available.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* No data state (both sections empty or no providers enabled) */}
          {!lbError && !lbLoading && !lbData && !lfmError && !lfmLoading && !lfmData && (
            <div style={{ color: 'var(--color-text-secondary)' }}>
              <p className="text-sm">No enrichment data available for this track.</p>
            </div>
          )}

          {/* Source attribution */}
          {(lbData || lfmData) && (
            <div className="pt-2 border-t space-y-1" style={{ borderColor: 'var(--color-border)' }}>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Data sources:
              </p>
              {lbData && (
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  ListenBrainz
                </p>
              )}
              {lfmData && (
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  Last.fm
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
