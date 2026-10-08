'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import Image from 'next/image';
import { useStore, queueRemove, nowPlayingSet, queueReorder, voteTrack, rpcErrorMessage, isTrackNotFoundError } from '@/lib/realtime';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import type { TrackRef } from '@cojam/shared';
import type { Member } from '@/lib/realtime';
import {
  PlayIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  TrashIcon,
  MusicNoteIcon,
} from '@/app/components/icons';
import { avatarGradient } from '@/lib/avatar';
import { memberLabel } from '@/lib/nameSuffix';

// Deezer-style total duration: "1 hr 23 min" / "42 min" / "< 1 min".
function formatTotal(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return '< 1 min';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} h ${m.toString().padStart(2, '0')} min` : `${m} min`;
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

const VOTER_STACK_MAX = 3;

function ChevronUp() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 15l7-7 7 7" />
    </svg>
  );
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
  // Authoritative timer handles, mutated synchronously. React state mirrors
  // this for rendering only; cancellation paths must not depend on a queued
  // updater flushing before the 4s timer fires (CodeRabbit #230).
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [actionError, setActionError] = useState('');
  // Phone only: which row has its secondary actions open (#289).
  const [moreOpenId, setMoreOpenId] = useState<string | null>(null);
  // Queue voting (F4): hydration-safe runtime flag (RFC-0006); the build-time
  // value is the SSR snapshot, the /env.js runtime map flips it post-mount.
  const { queueVoting: queueVotingEnabled } = useRuntimeFeatures();
  const listRef = useRef<HTMLDivElement>(null);
  const members = useStore((s) => s.members);
  const nameSuffixes = useStore((s) => s.nameSuffixes);
  const myClientId = useStore((s) => s.clientId);

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

  // #179: a track that becomes now-playing during its undo window must not be
  // removed 4s later. Watch the store for now-playing transitions and cancel
  // the pending removal (same cleanup as Undo) so the track keeps playing.
  useEffect(() => {
    return useStore.subscribe((s, prev) => {
      const id = s.state?.nowPlayingId;
      if (!id || id === prev.state?.nowPlayingId) return;
      const timer = timersRef.current.get(id);
      if (!timer) return;
      clearTimeout(timer);
      timersRef.current.delete(id);
      setUndoTimers((timers) => {
        if (!timers.has(id)) return timers;
        const next = new Map(timers);
        next.delete(id);
        return next;
      });
      setRemovingIds((ids) => {
        if (!ids.has(id)) return ids;
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
    });
  }, []);

  const handleVote = async (trackId: string) => {
    // Pending-removal rows are inert (#179): blocked in the UI, guarded here
    // too so a stray click can never vote for a half-removed track.
    if (removingIds.has(trackId)) return;
    setActionError('');
    const voted = !myVotes[trackId];
    try {
      await voteTrack(roomId, trackId);
      // No optimistic highlight: only the RPC success flips the pressed
      // state, so a rejection (rate limit, disconnect) leaves it alone.
      markVoted(trackId, voted);
    } catch (err) {
      setActionError(rpcErrorMessage(err, 'Não deu para votar nesta faixa. Tente de novo.'));
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
      // Last-moment guard against the now-playing race: even if the store
      // subscription's cancellation has not run, never remove the track that
      // is currently playing.
      if (useStore.getState().state?.nowPlayingId === trackId) {
        timersRef.current.delete(trackId);
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
        return;
      }
      try {
        await queueRemove(roomId, trackId);
      } catch (error) {
        // #179: "track not found" (#211) means someone else already removed it
        // (or it left the queue) during the undo window — the desired end
        // state is reached, so stay silent instead of a spurious failure.
        if (!isTrackNotFoundError(error)) {
          // Disconnected/unauthorized: the track stays; restore and say why.
          console.error('queue.remove failed:', error);
          setActionError(rpcErrorMessage(error, 'Não deu para remover esta faixa. Tente de novo.'));
        }
      } finally {
        timersRef.current.delete(trackId);
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

    timersRef.current.set(trackId, timer);
    setUndoTimers((prev) => new Map(prev).set(trackId, timer));
  };

  const handleUndo = (trackId: string) => {
    const timer = timersRef.current.get(trackId) ?? undoTimers.get(trackId);
    if (timer) {
      clearTimeout(timer);
    }
    timersRef.current.delete(trackId);
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
    if (removingIds.has(trackId)) return; // pending-removal rows are inert (#179)
    setActionError('');
    try {
      await nowPlayingSet(roomId, trackId);
    } catch (err) {
      setActionError(rpcErrorMessage(err, 'Não deu para tocar esta faixa. Tente de novo.'));
    }
  };

  const handleMove = async (trackId: string, toIndex: number) => {
    if (removingIds.has(trackId)) return; // pending-removal rows are inert (#179)
    setActionError('');
    try {
      await queueReorder(roomId, trackId, toIndex);
    } catch (err) {
      setActionError(rpcErrorMessage(err, 'Não deu para reordenar a fila. Tente de novo.'));
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
    `${queue.length} ${queue.length === 1 ? 'faixa' : 'faixas'}`,
    allDurationsKnown ? formatTotal(totalDurationMs) : null,
    `${contributors} ${contributors === 1 ? 'colaborador' : 'colaboradores'}`,
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

  // Who a vote belongs to. Vote keys are the server's rate-limit key:
  // "user:<userId>" (room auth) or "client:<clientId>" (no auth). Presence
  // entries carry both ids, so a voter resolves to a member while connected.
  // A voter who left the room stays anonymous ("alguém"). Built once per
  // render of the member list, not scanned per voter.
  const memberByVoteKey = useMemo(() => {
    const map = new Map<string, Member>();
    for (const m of members) {
      map.set(`client:${m.clientId}`, m);
      if (m.userId) map.set(`user:${m.userId}`, m);
    }
    return map;
  }, [members]);

  // The requester is stored by display name only; match it to a member so the
  // "pediu" avatar uses the same colour as that person in the presence bar.
  const memberByName = useMemo(() => {
    const map = new Map<string, Member>();
    for (const m of members) if (!map.has(m.name)) map.set(m.name, m);
    return map;
  }, [members]);

  // Mixed-service rooms: only flag a track the viewer's own service cannot play.
  const myPlatform = members.find((m) => m.clientId === myClientId)?.platform;
  const missingOnMyService = (track: TrackRef): string | null => {
    if (myPlatform === 'spotify' && !track.sources.spotify?.trackUri) return 'Spotify';
    if (myPlatform === 'apple' && !track.sources.apple?.songId) return 'Apple Music';
    if (myPlatform === 'youtube' && !track.sources.youtube?.videoId) return 'YouTube';
    return null;
  };

  const renderRow = (track: TrackRef, index: number, pinned: boolean) => {
    const requester = memberByName.get(track.addedBy);
    const requesterName = requester ? memberLabel(requester, nameSuffixes) : track.addedBy;
    const missing = missingOnMyService(track);
    const art = queueArtwork(track);
    const isNow = track.id === nowPlayingId;
    const isRemoving = removingIds.has(track.id);
    const pendingTitle = 'Remoção pendente. Desfaça para restaurar';
    const voters = state?.votes?.[track.id] ?? [];
    const voted = Boolean(myVotes[track.id]);
    const count = voters.length;
    const names = voters.map((k) => {
      const m = memberByVoteKey.get(k);
      return m ? memberLabel(m, nameSuffixes) : 'alguém';
    });
    const votersLabel = count > 0 ? `Votaram: ${names.join(', ')}` : '';
    const nameId = `fq-voters-${track.id}`;
    return (
      <div
        key={track.id}
        data-testid="queue-item"
        data-track-id={track.id}
        data-more={moreOpenId === track.id}
        role="listitem"
        className={`fq-row${isNow ? ' is-now' : ''}${pinned ? ' is-pinned' : ''}${isRemoving ? ' removing' : ''} group`}
      >
        <div className="fq-main">
          <span
            className="fq-av"
            role="img"
            aria-label={`Adicionada por ${requesterName}`}
            title={`Adicionada por ${requesterName}`}
            style={{ background: avatarGradient(requester ? requester.clientId || requester.name : track.addedBy) }}
          >
            {getInitial(track.addedBy)}
          </span>
          <div className="fq-art">
            {art ? (
              <Image src={art} alt="" width={pinned ? 56 : 44} height={pinned ? 56 : 44} unoptimized />
            ) : (
              <span className="fq-art__fallback" aria-hidden="true"><MusicNoteIcon size={16} /></span>
            )}
            {isNow && isPlaying && (
              <span className="queue-thumb-eq" aria-hidden="true"><span /><span /><span /></span>
            )}
          </div>
          <div className="fq-text">
            <span className="fq-kicker">
              {isNow ? 'Tocando agora · ' : ''}
              {requesterName} pediu
            </span>
            <div data-testid="queue-title" className="fq-title">{track.title}</div>
            <div className="fq-artist">{track.artist}</div>
            {missing && (
              <span className="fq-missing" role="img" aria-label={`Sem versão no ${missing}`} title={`Sem versão no ${missing}`}>
                Sem versão no {missing}
              </span>
            )}
            {track.id === listenersPickId && (
              <span data-testid="listeners-pick" className="fq-pick" title="Mais votada pelos ouvintes">
                Escolha dos ouvintes
              </span>
            )}
          </div>
          {queueVotingEnabled && (
            <button
              type="button"
              onClick={() => handleVote(track.id)}
              disabled={!connected || isRemoving}
              aria-label="Votar"
              aria-pressed={voted}
              aria-describedby={votersLabel ? nameId : undefined}
              title={isRemoving ? pendingTitle : votersLabel || (voted ? 'Remover seu voto' : 'Votar nesta faixa')}
              className="fq-vote"
              data-voted={voted}
            >
              <span className="fq-stack" aria-hidden="true">
                {voters.slice(0, VOTER_STACK_MAX).map((key) => {
                  const m = memberByVoteKey.get(key);
                  return (
                    <i key={key} className={m ? undefined : 'fq-stack__anon'} style={m ? { background: avatarGradient(m.clientId || m.name) } : undefined}>
                      {m ? getInitial(m.name) : '?'}
                    </i>
                  );
                })}
                {count > VOTER_STACK_MAX && <i className="fq-stack__more">+{count - VOTER_STACK_MAX}</i>}
                {count === 0 && <i className="fq-stack__empty" />}
              </span>
              <ChevronUp />
              <span data-testid="vote-count" className="fq-vote__n">{count}</span>
              {votersLabel && <span id={nameId} className="sr-only">{votersLabel}</span>}
            </button>
          )}
          {/* Phone and touch: opens the secondary actions on their own line so
              44px targets fit a 390px row (#289). */}
          <button
            type="button"
            onClick={() => setMoreOpenId((cur) => (cur === track.id ? null : track.id))}
            aria-label="Mais ações"
            aria-expanded={moreOpenId === track.id}
            title="Mais ações"
            className="fq-more"
          >
            <span aria-hidden="true">&#8943;</span>
          </button>
          <div className="fq-controls">
            <button
              onClick={() => handlePlay(track.id)}
              disabled={!canControl || isRemoving}
              aria-label="Tocar"
              title={isRemoving ? pendingTitle : canControl ? 'Tocar' : 'Só o anfitrião pode tocar faixas'}
            >
              <PlayIcon size={14} />
            </button>
            <button
              onClick={() => handleMoveUp(track.id, index)}
              disabled={index === 0 || !canControl || isRemoving}
              aria-label="Mover para cima"
              title={isRemoving ? pendingTitle : canControl ? 'Mover para cima' : 'Só o anfitrião pode reordenar faixas'}
            >
              <ArrowUpIcon size={14} />
            </button>
            <button
              onClick={() => handleMoveDown(track.id, index)}
              disabled={index === queue.length - 1 || !canControl || isRemoving}
              aria-label="Mover para baixo"
              title={isRemoving ? pendingTitle : canControl ? 'Mover para baixo' : 'Só o anfitrião pode reordenar faixas'}
            >
              <ArrowDownIcon size={14} />
            </button>
            <button
              onClick={() => handleRemove(track.id)}
              disabled={!canControl || isRemoving}
              aria-label="Remover"
              title={isRemoving ? pendingTitle : canControl ? 'Remover' : 'Só o anfitrião pode remover faixas'}
            >
              <TrashIcon size={14} />
            </button>
          </div>
        </div>
        {isRemoving && (
          <div className="undo-affordance fq-undo">
            <span>Removida: {track.title.length > 30 ? track.title.slice(0, 27) + '...' : track.title}</span>
            <button onClick={() => handleUndo(track.id)}>Desfazer</button>
          </div>
        )}
      </div>
    );
  };

  // The current track is pinned on top with CSS `order`, so the DOM keeps the
  // real queue order (reorder buttons, tab order and tests agree with it).
  const hasNow = queue.some((t) => t.id === nowPlayingId);

  return (
    // Not sticky itself: the side column (client.tsx) already pins the whole
    // rail. A second sticky here slid this panel over the Activity rail, which
    // shares its parent, whenever the page scrolled.
    <div data-testid="queue-panel" className="panel fq p-6 space-y-4 h-fit">
      <div>
        <h3 className="fq-h">Fila</h3>
        {queue.length > 0 && <p className="fq-agg">{aggregate}</p>}
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
            A fila está vazia
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Adicione uma faixa para começar
          </p>
        </div>
      ) : (
        <div className="fq-list">
          {/* Outside role="list" so the list holds only listitems; display:contents
              on the list keeps the sub-heading in the same flex order as the rows. */}
          {hasNow && queue.length > 1 && <p className="fq-sub">A seguir</p>}
          <div ref={listRef} role="list" aria-label="Faixas na fila" className="fq-items">
            {queue.map((t, i) => renderRow(t, i, hasNow && t.id === nowPlayingId))}
          </div>
        </div>
      )}
    </div>
  );
}
