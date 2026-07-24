'use client';

import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import { useStore, queueRemove, nowPlayingSet, queueReorder, voteTrack, rpcErrorMessage } from '@/lib/realtime';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import type { TrackRef } from '@cojam/shared';
import {
  SpotifyIcon,
  YouTubeIcon,
  AppleMusicIcon,
  PlayIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  TrashIcon,
  ThumbsUpIcon,
  MusicNoteIcon,
} from '@/app/components/icons';
import { formatTime } from './TransportUI';
import { formatRelativeTime } from '@/lib/relativeTime';

// Deezer-style total duration: "1 hr 23 min" / "42 min" / "< 1 min".
function formatTotal(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return '< 1 min';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} hr ${m.toString().padStart(2, '0')} min` : `${m} min`;
}

// queueArtwork resolves the row thumb: the stored artwork URL first (search
// adds + Spotify playlist imports carry it), then a derived YouTube thumb
// (deterministic from the video id, no stored data needed), else null and the
// caller renders the fallback tile. Exported for unit tests.
export function queueArtwork(track: TrackRef): string | null {
  if (track.artworkUrl) return track.artworkUrl;
  const videoId = track.sources.youtube?.videoId;
  return videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : null;
}

interface QueuePanelProps {
  roomId: string;
  canControl: boolean;
}

export function QueuePanel({ roomId, canControl }: QueuePanelProps) {
  const state = useStore((s) => s.state);
  const queue = state?.queue ?? [];
  const nowPlayingId = state?.nowPlayingId;
  const connected = useStore((s) => s.connected);
  const myVotes = useStore((s) => s.myVotes);
  const markVoted = useStore((s) => s.markVoted);
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [undoTimers, setUndoTimers] = useState<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [actionError, setActionError] = useState('');
  // Queue voting (F4): hydration-safe runtime flag (RFC-0006); the build-time
  // value is the SSR snapshot, the /env.js runtime map flips it post-mount.
  const { queueVoting: queueVotingEnabled } = useRuntimeFeatures();
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the now-playing row in view when it advances (Vibrdrome steal: the
  // queue auto-scrolls to now playing). Guarded for jsdom (no scrollIntoView /
  // matchMedia) and reduced-motion users (instant, not smooth).
  useEffect(() => {
    if (!nowPlayingId || !listRef.current) return;
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(nowPlayingId) : nowPlayingId;
    const el = listRef.current.querySelector(`[data-track-id="${escaped}"]`);
    if (!el || typeof el.scrollIntoView !== 'function') return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [nowPlayingId]);

  const handleVote = async (trackId: string) => {
    setActionError('');
    const voted = !myVotes[trackId];
    try {
      await voteTrack(roomId, trackId);
      // No optimistic highlight: only the RPC success flips the pressed
      // state, so a rejection (rate limit, disconnect) leaves it alone.
      markVoted(trackId, voted);
    } catch (err) {
      setActionError(rpcErrorMessage(err, 'Couldn\'t vote for that track. Try again.'));
    }
  };

  const handleRemove = async (trackId: string) => {
    // Second click while an undo window is open would schedule a duplicate
    // timer that bypasses Undo; ignore it.
    if (removingIds.has(trackId)) return;
    // Clear any stale action error: a successful removal must not leave a
    // previous failure's alert visible.
    setActionError('');
    setRemovingIds((prev) => new Set([...prev, trackId]));
    const timer = setTimeout(async () => {
      try {
        await queueRemove(roomId, trackId);
      } catch (error) {
        // Disconnected/unauthorized: the track stays; restore and say why.
        console.error('queue.remove failed:', error);
        setActionError(rpcErrorMessage(error, 'Couldn\'t remove that track. Try again.'));
      } finally {
        setRemovingIds((prev) => {
          const next = new Set(prev);
          next.delete(trackId);
          return next;
        });
        setUndoTimers((prev) => {
          const next = new Map(prev);
          next.delete(trackId);
          return next;
        });
      }
    }, 4000);

    setUndoTimers((prev) => new Map(prev).set(trackId, timer));
  };

  const handleUndo = (trackId: string) => {
    const timer = undoTimers.get(trackId);
    if (timer) {
      clearTimeout(timer);
    }
    setRemovingIds((prev) => {
      const next = new Set(prev);
      next.delete(trackId);
      return next;
    });
    setUndoTimers((prev) => {
      const next = new Map(prev);
      next.delete(trackId);
      return next;
    });
  };

  const handlePlay = async (trackId: string) => {
    setActionError('');
    try {
      await nowPlayingSet(roomId, trackId);
    } catch (err) {
      setActionError(rpcErrorMessage(err, 'Couldn\'t play that track. Try again.'));
    }
  };

  const handleMove = async (trackId: string, toIndex: number) => {
    setActionError('');
    try {
      await queueReorder(roomId, trackId, toIndex);
    } catch (err) {
      setActionError(rpcErrorMessage(err, 'Couldn\'t reorder the queue. Try again.'));
    }
  };

  const handleMoveUp = async (trackId: string, currentIndex: number) => {
    if (currentIndex > 0) {
      await handleMove(trackId, currentIndex - 1);
    }
  };

  const handleMoveDown = async (trackId: string, currentIndex: number) => {
    if (currentIndex < queue.length - 1) {
      await handleMove(trackId, currentIndex + 1);
    }
  };

  const getInitial = (name: string): string => {
    return name.charAt(0).toUpperCase();
  };

  // Aggregate header (R2). Duration only when every row reports one, so the
  // total is never silently partial. `!= null`: 0ms is known metadata.
  const totalDurationMs = queue.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
  const allDurationsKnown = queue.length > 0 && queue.every((t) => t.durationMs != null);
  const contributors = new Set(queue.map((t) => t.addedBy)).size;
  const isPlaying = state?.transport?.state === 'playing';
  const aggregate = [
    `${queue.length} ${queue.length === 1 ? 'track' : 'tracks'}`,
    allDurationsKnown ? formatTotal(totalDurationMs) : null,
    `${contributors} ${contributors === 1 ? 'contributor' : 'contributors'}`,
  ].filter(Boolean).join(' · ');

  // Listeners' pick (F4): the queued track with the most votes, excluding now
  // playing. Pure render-side derivation: a reorder SUGGESTION only, the host
  // keeps full control of the actual order via queue.reorder.
  let listenersPickId: string | null = null;
  if (queueVotingEnabled) {
    let maxVotes = 0;
    for (const t of queue) {
      if (t.id === nowPlayingId) continue;
      const count = state?.votes?.[t.id]?.length ?? 0;
      if (count > maxVotes) {
        maxVotes = count;
        listenersPickId = t.id;
      }
    }
  }

  return (
    // z-10: as the sticky panel it must paint above later-flowing positioned
    // panels (ChatPanel) that slide under it while the column scrolls, or
    // they'd cover the queue controls and intercept their clicks.
    <div className="panel p-6 space-y-4 h-fit lg:sticky lg:top-24 z-10">
      <div>
        <h3 className="text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          Queue
        </h3>
        {queue.length > 0 && <p className="queue-agg">{aggregate}</p>}
      </div>

      {actionError && (
        <p role="alert" aria-live="polite" className="text-sm" style={{ color: 'var(--color-status-error)' }}>
          {actionError}
        </p>
      )}

      {queue.length === 0 ? (
        <div className="py-8 text-center">
          <div className="flex justify-center mb-2" style={{ color: 'var(--color-text-muted)' }}>
            <MusicNoteIcon size={28} />
          </div>
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            Queue is empty
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Add a track to get started
          </p>
        </div>
      ) : (
        <div ref={listRef} className="space-y-2 max-h-96 overflow-y-auto pr-2">
          {queue.map((track, index) => {
            const art = queueArtwork(track);
            return (
            <div
              key={track.id}
              data-testid="queue-item"
              data-track-id={track.id}
              className={`queue-item-row animate-fade-in-up group${track.id === nowPlayingId ? ' is-now' : ''}${removingIds.has(track.id) ? ' removing' : ''}`}
            >
              <div className="flex w-full items-center gap-2.5 p-2.5 rounded-lg transition-all duration-150 hover:bg-[color-mix(in_oklab,var(--color-accent)_3%,transparent)] focus-within:bg-[color-mix(in_oklab,var(--color-accent)_3%,transparent)]">
                {/* Position: plain number, accent when now playing. The eq moved
                    onto the thumb (Spotify-style overlay). */}
                <div className="text-xs font-semibold flex-shrink-0 w-5 text-center" style={{ color: track.id === nowPlayingId ? 'var(--color-accent)' : 'var(--color-text-muted)' }}>
                  {index + 1}
                </div>

                {/* Thumb: album art (stored or YouTube-derived) or a fallback
                    tile. Now-playing gets the eq overlay only while actually
                    playing (state honesty, DESIGN.md R6). */}
                <div className="queue-thumb-wrap">
                  {art ? (
                    // Artwork hosts vary by provider (Spotify, Apple, Deezer,
                    // YouTube CDNs); serve unoptimized like the search dropdown.
                    <Image
                      src={art}
                      alt=""
                      className="queue-thumb"
                      width={40}
                      height={40}
                      unoptimized
                    />
                  ) : (
                    <span className="queue-thumb queue-thumb-fallback" aria-hidden="true">
                      <MusicNoteIcon size={16} />
                    </span>
                  )}
                  {track.id === nowPlayingId && isPlaying && (
                    <span className="queue-thumb-eq" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                  )}
                </div>

                {/* Title + one meta line. Source icons and provenance fold into
                    the meta line; the listeners' pick rides the title row. */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div data-testid="queue-title" className="font-medium text-sm truncate" style={{ color: 'var(--color-text-primary)' }}>
                      {track.title}
                    </div>
                    {track.id === listenersPickId && (
                      <span
                        data-testid="listeners-pick"
                        className="inline-flex items-center text-xs font-semibold flex-shrink-0"
                        style={{ color: 'var(--color-accent)' }}
                        title="Most upvoted by listeners"
                      >
                        Listeners&rsquo; pick
                      </span>
                    )}
                  </div>
                  <div className="queue-meta">
                    <span className="truncate">{track.artist}</span>
                    {track.sources.youtube && (
                      <span
                        className="badge-source badge-youtube inline-flex items-center flex-shrink-0"
                        title={`YouTube match ${Math.round(track.sources.youtube.confidence * 100)}%`}
                      >
                        <YouTubeIcon size={10} />
                      </span>
                    )}
                    {track.sources.apple && (
                      <span
                        className="badge-source badge-apple inline-flex items-center flex-shrink-0"
                        title={`Apple Music match ${Math.round(track.sources.apple.confidence * 100)}%`}
                      >
                        <AppleMusicIcon size={10} />
                      </span>
                    )}
                    {track.sources.spotify && (
                      <span
                        className="badge-source badge-spotify inline-flex items-center flex-shrink-0"
                        title={`Spotify match ${Math.round(track.sources.spotify.confidence * 100)}%`}
                      >
                        <SpotifyIcon size={10} />
                      </span>
                    )}
                    <span className="queue-meta-sep" aria-hidden="true">·</span>
                    <span className="avatar-chip-sm inline-flex flex-shrink-0" style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)', width: '16px', height: '16px', fontSize: '0.55rem', padding: 0 }}>
                      {getInitial(track.addedBy)}
                    </span>
                    <span className="flex-shrink-0">{track.addedBy}</span>
                    {/* Server-stamped addedAt (R1 provenance). Silent when 0/absent
                        on tracks queued before timestamps existed (honest data). */}
                    {track.addedAt ? (
                      <>
                        <span className="queue-meta-sep" aria-hidden="true">·</span>
                        <span className="flex-shrink-0">{formatRelativeTime(track.addedAt)}</span>
                      </>
                    ) : null}
                  </div>
                </div>

                {/* Per-row duration (R9): right-aligned tabular, before the
                    hover-revealed controls. */}
                {track.durationMs != null && (
                  <span className="queue-duration">{formatTime(track.durationMs)}</span>
                )}

                {/* Vote (F4): always visible, for every member regardless of
                    canControl (voting is the listener control); disabled only
                    while disconnected. The count must stay on screen, so this
                    sits outside the hover-revealed controls below. */}
                {queueVotingEnabled && (
                  <button
                    onClick={() => handleVote(track.id)}
                    disabled={!connected}
                    aria-label="Vote"
                    aria-pressed={Boolean(myVotes[track.id])}
                    title={myVotes[track.id] ? 'Remove your vote' : 'Vote for this track'}
                    className="p-1.5 rounded transition-all duration-150 hover:brightness-110 active:scale-90 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 flex-shrink-0"
                    style={{
                      backgroundColor: myVotes[track.id] ? 'var(--color-accent)' : 'var(--color-surface-3)',
                      color: myVotes[track.id] ? 'var(--color-surface-0)' : 'var(--color-text-primary)',
                    }}
                  >
                    <ThumbsUpIcon size={14} />
                    <span data-testid="vote-count" className="text-xs font-semibold">
                      {state?.votes?.[track.id]?.length ?? 0}
                    </span>
                  </button>
                )}

                {/* Right side: controls (hidden on desktop hover, always visible on touch) */}
                <div className="queue-controls flex gap-1 flex-shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                  <button
                    onClick={() => handlePlay(track.id)}
                    disabled={!canControl}
                    aria-label="Play"
                    title={canControl ? 'Play' : 'Only the host can play tracks'}
                    className="p-1.5 rounded transition-all duration-150 hover:brightness-110 active:scale-90 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-surface-0)' }}
                  >
                    <PlayIcon size={14} />
                  </button>
                  <button
                    onClick={() => handleMoveUp(track.id, index)}
                    disabled={index === 0 || !canControl}
                    aria-label="Move up"
                    title={canControl ? 'Move up' : 'Only the host can reorder tracks'}
                    className="p-1.5 rounded transition-all duration-150 hover:opacity-70 active:scale-90 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: 'var(--color-surface-3)', color: 'var(--color-text-primary)' }}
                  >
                    <ArrowUpIcon size={14} />
                  </button>
                  <button
                    onClick={() => handleMoveDown(track.id, index)}
                    disabled={index === queue.length - 1 || !canControl}
                    aria-label="Move down"
                    title={canControl ? 'Move down' : 'Only the host can reorder tracks'}
                    className="p-1.5 rounded transition-all duration-150 hover:opacity-70 active:scale-90 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: 'var(--color-surface-3)', color: 'var(--color-text-primary)' }}
                  >
                    <ArrowDownIcon size={14} />
                  </button>
                  <button
                    onClick={() => handleRemove(track.id)}
                    disabled={!canControl}
                    aria-label="Remove"
                    title={canControl ? 'Remove' : 'Only the host can remove tracks'}
                    className="p-1.5 rounded transition-all duration-150 hover:opacity-70 active:scale-90 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: 'var(--color-surface-3)', color: 'var(--color-text-primary)' }}
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
              </div>

              {removingIds.has(track.id) && (
                <div className="undo-affordance w-full flex items-center justify-between">
                  <span style={{ color: 'var(--color-text-secondary)' }}>
                    Removed {track.title.length > 30 ? track.title.slice(0, 27) + '...' : track.title}
                  </span>
                  <button
                    onClick={() => handleUndo(track.id)}
                    className="text-xs font-semibold px-2 py-1 rounded transition-all duration-150 hover:brightness-110"
                    style={{ color: 'var(--color-accent)' }}
                  >
                    Undo
                  </button>
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
