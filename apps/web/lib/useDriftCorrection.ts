import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, requestClockRemeasure, nowPlayingAdvance } from './realtime';
import { computeExpectedPosition, shouldCorrect, isExpectedPositionKnown, isPastEnd, DRIFT_THRESHOLD_MS, seekCooldownMs, serverNow } from './playbackSync';
import type { IPlayer } from './playerInterface';

// U4: Drift correction loop (gated by the sync feature flag).
// Monitors transport state and corrects playback position drift.
//
// The selector memoizes the meaningful transport FIELDS (state, positionMs,
// updatedAtServerMs) via useShallow instead of depending on the transport
// object identity: every room.state publication (vote, queue add, reorder)
// carries a fresh transport object, and depending on identity re-called
// play()/seekToMs() and recreated the drift interval on every publication —
// two Spotify REST calls per publication per Spotify listener (#177).
//
// Past the end: a playing transport whose expected position is beyond the
// now-playing track's duration (host gone, or restored stale after a server
// restart) must never be sought to: YouTube jumps to the end and the loop
// corrects it again. Anyone who can control advances once through the existing
// now_playing.advance RPC (guarded per track, the server also dedups on
// afterId); everyone else stops correcting and waits for the room to move.
const ADVANCE_RETRY_MS = 10_000;

export function useDriftCorrection(activePlayer: IPlayer | null, syncEnabled: boolean, canAdvance = false) {
  const driftCorrectionIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const canAdvanceRef = useRef(canAdvance);
  useEffect(() => {
    canAdvanceRef.current = canAdvance;
  }, [canAdvance]);
  const advancedRef = useRef<{ id: string; at: number } | null>(null);
  const transport = useStore(
    useShallow((s) => {
      const t = s.state?.transport;
      return t ? { state: t.state, positionMs: t.positionMs, updatedAtServerMs: t.updatedAtServerMs } : undefined;
    }),
  );

  // Returns true when the transport is past the end of the now-playing track
  // (the caller must not seek); advances once if this user can control.
  const handlePastEnd = (current: { state: 'playing' | 'paused' | 'stopped'; positionMs: number; updatedAtServerMs: number }, now: number): boolean => {
    const st = useStore.getState().state;
    const id = st?.nowPlayingId;
    const durationMs = id ? st?.queue.find((t) => t.id === id)?.durationMs : undefined;
    if (!id || !isPastEnd(current, now, durationMs)) return false;
    const last = advancedRef.current;
    if (canAdvanceRef.current && (!last || last.id !== id || Date.now() - last.at > ADVANCE_RETRY_MS)) {
      advancedRef.current = { id, at: Date.now() };
      nowPlayingAdvance(st.roomId, id).catch((err) => {
        console.warn('Failed to advance past a track that already ended:', err);
      });
    }
    return true;
  };

  useEffect(() => {
    if (!syncEnabled || !activePlayer || !transport) return;

    let lastSeekAt = 0;
    // Corrective seeks in a row without drift settling (see seekCooldownMs).
    let consecutiveSeeks = 0;
    let resumeTried = false;
    // Handle state transitions: play/pause/stop
    if (transport.state === 'playing') {
      activePlayer.play().catch((err) => {
        console.warn('Failed to play:', err);
      });
      // Seek to expected position to sync with server
      const now = serverNow();
      if (handlePastEnd(transport, now)) {
        // Past the end: no seek (see the header comment).
      } else if (isExpectedPositionKnown(transport, now)) {
        const expected = computeExpectedPosition(transport, now);
        lastSeekAt = Date.now();
        activePlayer.seekToMs(expected).catch((err) => {
          if (activePlayer.canSeek()) {
            console.warn('Failed to seek to expected position:', err);
          }
          // If !canSeek (e.g. Spotify free tier), silently continue
        });
      } else {
        // Clock offset is wrong: never seek to a clamped 0. Skip only this
        // initial seek; the interval below corrects once the offset lands.
        requestClockRemeasure();
      }
    } else if (transport.state === 'paused') {
      activePlayer.pause().catch((err) => {
        console.warn('Failed to pause:', err);
      });
    }

    // If playing and the player supports seek, set up drift correction loop
    if (transport.state !== 'playing' || !activePlayer.canSeek()) {
      // Clean up any existing interval
      if (driftCorrectionIntervalRef.current) {
        clearInterval(driftCorrectionIntervalRef.current);
        driftCorrectionIntervalRef.current = null;
      }
      return;
    }

    // Start drift correction interval: check ~every 1500ms
    driftCorrectionIntervalRef.current = setInterval(() => {
      // Re-check the latest state in case it changed since the interval started
      const current = useStore.getState().state?.transport;
      if (!current || current.state !== 'playing') {
        if (driftCorrectionIntervalRef.current) {
          clearInterval(driftCorrectionIntervalRef.current);
          driftCorrectionIntervalRef.current = null;
        }
        return;
      }

      const now = serverNow();
      if (!isExpectedPositionKnown(current, now)) {
        requestClockRemeasure();
        return;
      }
      if (handlePastEnd(current, now)) return;
      // Cued/buffering/unstarted reads are unreliable (getCurrentTime() is 0).
      if (activePlayer.isPlaying && !activePlayer.isPlaying()) {
        // Paused while the room plays (e.g. autoplay blocked): try play() once
        // per transport change, never in a loop.
        if (!resumeTried && activePlayer.isPaused?.()) {
          resumeTried = true;
          activePlayer.play().catch(() => {});
        }
        return;
      }
      // Let the last seek settle before judging drift again.
      if (Date.now() - lastSeekAt < seekCooldownMs(consecutiveSeeks)) return;
      const expected = computeExpectedPosition(current, now);

      activePlayer.getCurrentPositionMs()
        .then((actual) => {
          const drift = actual - expected;
          if (!shouldCorrect(drift, DRIFT_THRESHOLD_MS)) {
            consecutiveSeeks = 0;
          } else {
            lastSeekAt = Date.now();
            consecutiveSeeks++;
            activePlayer.seekToMs(expected).catch((err) => {
              console.warn('Drift correction seek failed:', err);
            });
          }
        })
        .catch((err) => {
          console.warn('Failed to get current position for drift check:', err);
        });
    }, 1500);

    return () => {
      if (driftCorrectionIntervalRef.current) {
        clearInterval(driftCorrectionIntervalRef.current);
        driftCorrectionIntervalRef.current = null;
      }
    };
  }, [activePlayer, transport, syncEnabled]);
}
