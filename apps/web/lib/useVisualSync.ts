import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from './realtime';
import { computeExpectedPosition, isExpectedPositionKnown, serverNow } from './playbackSync';
import type { IPlayer } from './playerInterface';

// Modo palco, decision 8 (docs/design/modo-palco.md): a listener on Spotify
// sees the room's YouTube video on the stage screen, muted, while their own
// service plays the audio. This keeps that video in step with the room
// transport. Visual only, so the drift allowed is relaxed (a lip-sync miss of
// a second does not matter, a seek every tick would), and it never advances
// the room, reports a failure or touches the audio player.
export const VISUAL_DRIFT_MS = 3000;
export const VISUAL_TICK_MS = 2000;

type Transport = { state: 'playing' | 'paused' | 'stopped'; positionMs: number; updatedAtServerMs: number };

// One correction step: what it did, for tests.
export async function visualSyncStep(player: IPlayer, transport: Transport | undefined, now: number): Promise<'play' | 'pause' | 'seek' | null> {
  if (!transport) return null;
  const playing = player.isPlaying ? player.isPlaying() : false;
  if (transport.state !== 'playing') {
    if (!playing) return null;
    await player.pause();
    return 'pause';
  }
  if (!playing) {
    await player.play();
    return 'play';
  }
  if (!isExpectedPositionKnown(transport, now)) return null;
  const expected = computeExpectedPosition(transport, now);
  const pos = await player.getCurrentPositionMs();
  if (Math.abs(pos - expected) <= VISUAL_DRIFT_MS) return null;
  await player.seekToMs(expected);
  return 'seek';
}

export function useVisualSync(player: IPlayer | null): void {
  const transport = useStore(
    useShallow((s) => {
      const t = s.state?.transport;
      return t ? { state: t.state, positionMs: t.positionMs, updatedAtServerMs: t.updatedAtServerMs } : undefined;
    }),
  );
  useEffect(() => {
    if (!player) return;
    const step = () => {
      visualSyncStep(player, transport, serverNow()).catch(() => {
        /* the video is decoration: a failed step waits for the next tick */
      });
    };
    step();
    const id = setInterval(step, VISUAL_TICK_MS);
    return () => clearInterval(id);
  }, [player, transport]);
}
