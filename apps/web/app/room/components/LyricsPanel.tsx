'use client';

import { useState, useEffect, useRef } from 'react';
import type { TrackRef } from '@cojam/shared';
import type { IPlayer } from '@/lib/playerInterface';
import { fetchLyrics } from '@/lib/realtime';
import { activeLineIndex } from '@/lib/lyricSync';

interface LyricsPanelProps {
  roomId: string;
  track: TrackRef | null;
  open: boolean;
  onClose: () => void;
  activePlayer?: IPlayer | null;
}

export function LyricsPanel({ roomId, track, open, onClose, activePlayer }: LyricsPanelProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [retry, setRetry] = useState(0);
  const [currentPositionMs, setCurrentPositionMs] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const lyricsContentRef = useRef<HTMLDivElement>(null);
  const activeLineRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // Element focused before the panel opened, restored on close.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // onClose changes identity each parent render; hold it in a ref so the focus
  // effect can depend on [open] alone and not tear down on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const positionPollingRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!open || !track) {
      setData(null);
      setError(null);
      return;
    }

    let cancelled = false;
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
        if (!cancelled) setData(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to fetch lyrics');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchData();
    // Guard against a stale response (track/room changed mid-flight, or a retry)
    // overwriting the current track's lyrics.
    return () => {
      cancelled = true;
    };
  }, [open, track, roomId, retry]);

  // Position polling for active-line highlighting
  useEffect(() => {
    if (!open || !activePlayer || !data?.synced || data.synced.length === 0) {
      if (positionPollingRef.current) {
        clearInterval(positionPollingRef.current);
        positionPollingRef.current = null;
      }
      return;
    }

    positionPollingRef.current = setInterval(() => {
      activePlayer.getCurrentPositionMs()
        .then((posMs) => {
          setCurrentPositionMs(posMs);
        })
        .catch((err) => {
          console.warn('Failed to get current position for lyrics sync:', err);
        });
    }, 300);

    return () => {
      if (positionPollingRef.current) {
        clearInterval(positionPollingRef.current);
        positionPollingRef.current = null;
      }
    };
  }, [open, activePlayer, data?.synced]);

  // Auto-scroll active line into view
  useEffect(() => {
    if (!open || !data?.synced || data.synced.length === 0) return;

    const currIdx = activeLineIndex(data.synced, currentPositionMs);
    if (currIdx < 0) return;

    const lineEl = activeLineRefs.current.get(currIdx);
    if (!lineEl) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    lineEl.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'nearest',
    });
  }, [currentPositionMs, open, data?.synced]);

  // Dialog focus management: move focus into the panel on open, trap Tab within
  // it, close on Esc, and restore focus to the prior element on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => !el.hasAttribute('disabled'));

    focusables()[0]?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocusedRef.current?.focus();
    };
  }, [open]);

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
        role="dialog"
        aria-modal="true"
        aria-label={`Lyrics for ${track.title}`}
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
                  setRetry((n) => n + 1);
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
                <div className="space-y-2" ref={lyricsContentRef}>
                  {data.synced.map((line: any, idx: number) => {
                    const isActive = activeLineIndex(data.synced, currentPositionMs) === idx;
                    return (
                      <div
                        key={idx}
                        ref={(el) => {
                          if (el) activeLineRefs.current.set(idx, el);
                          else activeLineRefs.current.delete(idx);
                        }}
                        className="py-2 px-3 rounded text-sm transition-all duration-150"
                        style={{
                          backgroundColor: isActive ? 'var(--color-accent)' : 'var(--color-surface-2)',
                          color: isActive ? 'var(--color-surface-0)' : 'var(--color-text-primary)',
                          fontWeight: isActive ? '600' : '400',
                        }}
                      >
                        <span className="text-xs" style={{ color: isActive ? 'var(--color-surface-0)' : 'var(--color-text-muted)', opacity: isActive ? 0.9 : 1 }}>
                          {Math.floor(line.timeMs / 60000)}:{String(Math.floor((line.timeMs % 60000) / 1000)).padStart(2, '0')}
                        </span>
                        <span className="ml-3">{line.text}</span>
                      </div>
                    );
                  })}
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
