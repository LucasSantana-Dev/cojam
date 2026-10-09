'use client';

// "Pular 1/2": vote to skip the playing track (now_playing.vote_skip). Shown
// to every member next to Curtir (palco) and the transport (round 4); the
// host keeps the direct skip. Pressed = you voted (the violet action style).
// Hidden when nothing plays or queue voting is off (the same flag as queue.vote).
import { useState } from 'react';
import { useStore, nowPlayingVoteSkip } from '@/lib/realtime';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import { skipVoteKey, skipVotesNeeded } from '@/lib/skipVote';

export function SkipVoteButton({ roomId, variant }: { roomId: string; variant: 'palco' | 'r4' }) {
  const { queueVoting } = useRuntimeFeatures();
  const nowPlayingId = useStore((s) => s.state?.nowPlayingId);
  const count = useStore((s) => s.state?.skipVotes?.length ?? 0);
  const listeners = useStore((s) => s.members.length);
  const voted = useStore((s) => (nowPlayingId ? Boolean(s.myVotes[skipVoteKey(nowPlayingId)]) : false));
  const [busy, setBusy] = useState(false);

  if (!queueVoting || !nowPlayingId) return null;
  const need = skipVotesNeeded(listeners);

  const toggle = () => {
    if (busy) return;
    setBusy(true);
    nowPlayingVoteSkip(roomId, nowPlayingId, !voted)
      .catch((err) => console.error('Vote skip error:', err))
      .finally(() => setBusy(false));
  };

  return (
    <button
      type="button"
      className={`skipvote skipvote--${variant}`}
      aria-pressed={voted}
      aria-disabled={busy || undefined}
      aria-label={`Pular música, ${count} de ${need} votos`}
      title={voted ? 'Tirar meu voto para pular' : 'Votar para pular esta música'}
      onClick={toggle}
    >
      Pular {count}/{need}
    </button>
  );
}
