'use client';

import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
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
  PlusIcon,
  BlockIcon,
} from '@/app/components/icons';
import { memberLabel } from '@/lib/nameSuffix';

// queueArtwork resolves the row thumb: the stored artwork URL first (search
// adds + Spotify playlist imports carry it), then a derived YouTube thumb
// (deterministic from the video id, no stored data needed), else null and the
// caller renders the fallback tile. Exported for unit tests.
export function queueArtwork(track: TrackRef): string | null {
  if (track.artworkUrl) return track.artworkUrl;
  const videoId = track.sources.youtube?.videoId;
  return videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : null;
}

function ThumbUp() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M2 10.5h4V21H2V10.5zm6 .5 4.1-8c1.2 0 2.3.9 2.3 2.2l-.1.7L13.6 9H20c1.1 0 2 .9 2 2 0 .3-.1.5-.2.8l-2.6 6.3c-.3.8-1.1 1.4-2 1.4H8V11z" />
    </svg>
  );
}

interface QueuePanelProps {
  roomId: string;
  canControl: boolean;
  // The service this person listens through ("Ouvir no"); drives the "missing on your service" flag.
  listeningOn?: 'spotify' | 'apple' | 'youtube' | null;
  // "+ Adicionar música" in the header toggles the inline add area at the top
  // of the list (addSlot). Omitted, the link is not rendered.
  onAdd?: () => void;
  addOpen?: boolean;
  addSlot?: ReactNode;
  // Shown instead of the plain empty text (the first-run guide).
  emptySlot?: ReactNode;
}

export function QueuePanel({ roomId, canControl, onAdd, addOpen = false, addSlot, emptySlot, listeningOn }: QueuePanelProps) {
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

  // Opening the inline add area puts the cursor in its search field.
  const addRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (addOpen) addRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [addOpen]);

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
      for (const id of m.clientIds ?? [m.clientId]) map.set(`client:${id}`, m);
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
  // The room passes the service this person chose ("Ouvir no"); presence is the fallback.
  const myPlatform = listeningOn ?? members.find((m) => (m.clientIds ?? [m.clientId]).includes(myClientId))?.platform;
  const missingOnMyService = (track: TrackRef): string | null => {
    if (myPlatform === 'spotify' && !track.sources.spotify?.trackUri) return 'Spotify';
    if (myPlatform === 'apple' && !track.sources.apple?.songId) return 'Apple Music';
    if (myPlatform === 'youtube' && !track.sources.youtube?.videoId) return 'YouTube';
    return null;
  };

  const renderRow = (track: TrackRef, index: number) => {
    const requester = memberByName.get(track.addedBy);
    const requesterName = requester ? memberLabel(requester, nameSuffixes) : track.addedBy;
    const missing = missingOnMyService(track);
    const art = queueArtwork(track);
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
        className={`fq-row${isRemoving ? ' removing' : ''} group`}
      >
        <div className="fq-main">
          <div className="fq-art">
            {art ? (
              <Image src={art} alt="" width={56} height={56} unoptimized />
            ) : (
              <span className="fq-art__fallback" aria-hidden="true"><MusicNoteIcon size={18} /></span>
            )}
          </div>
          <div className="fq-text">
            <div data-testid="queue-title" className="fq-title">{track.title}</div>
            <div className="fq-artist">{track.artist}</div>
            <div className="fq-meta">
              <span className="fq-chip" title={`Adicionada por ${requesterName}`}>
                {requesterName} pediu
              </span>
              {track.id === listenersPickId && (
                <span data-testid="listeners-pick" className="fq-pick" title="Mais votada pelos ouvintes">
                  Escolha dos ouvintes
                </span>
              )}
              {missing && (
                <span className="fq-missing" role="img" aria-label={`Sem versão no ${missing}`} title={`Sem versão no ${missing}`}>
                  <BlockIcon size={14} />
                </span>
              )}
            </div>
          </div>
          {queueVotingEnabled && (
            <div className="fq-votecol" data-voted={voted}>
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
                <ThumbUp />
                {votersLabel && <span id={nameId} className="sr-only">{votersLabel}</span>}
              </button>
              <span className="fq-pill" data-has={count > 0}>
                <span data-testid="vote-count">{count}</span>{count === 1 ? ' voto' : ' votos'}
              </span>
            </div>
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

  // The playing track lives in the now-playing card, not in this list. Rows keep
  // their real queue index so the reorder buttons move the right track.
  const upcoming = queue.filter((t) => t.id !== nowPlayingId);

  return (
    // Not sticky itself: the side column (client.tsx) already pins the whole rail.
    <div data-testid="queue-panel" className="panel fq r4-card">
      <header className="r4-qhead">
        <h3 className="r4-h2">
          A seguir <span className="r4-h2__n">({upcoming.length})</span>
        </h3>
        {onAdd && (
          <button type="button" onClick={onAdd} className="r4-link" aria-expanded={addOpen} aria-controls="r4-add-inline">
            <PlusIcon size={16} />
            Adicionar música
          </button>
        )}
      </header>

      {actionError && (
        <p role="alert" aria-live="polite" className="text-sm" style={{ color: 'var(--color-status-error)' }}>
          {actionError}
        </p>
      )}

      <div className="fq-list">
        {addSlot && (
          <div id="r4-add-inline" ref={addRef} className="r4-addinline" hidden={!addOpen}>
            {addSlot}
          </div>
        )}
        {upcoming.length === 0 ? (
          emptySlot ?? (
            <div className="fq-empty">
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
          )
        ) : (
          <div ref={listRef} role="list" aria-label="Faixas na fila" className="fq-items">
            {queue.map((t, i) => (t.id === nowPlayingId ? null : renderRow(t, i)))}
          </div>
        )}
      </div>
    </div>
  );
}
