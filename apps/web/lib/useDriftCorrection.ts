import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, measureClockOffsetWithRetry } from './realtime';
import { computeExpectedPosition, shouldCorrect, isExpectedPositionKnown, DRIFT_THRESHOLD_MS, SEEK_COOLDOWN_MS, serverNow } from './playbackSync';
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
export function useDriftCorrection(activePlayer: IPlayer | null, syncEnabled: boolean) {
  const driftCorrectionIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const transport = useStore(
    useShallow((s) => {
      const t = s.state?.transport;
      return t ? { state: t.state, positionMs: t.positionMs, updatedAtServerMs: t.updatedAtServerMs } : undefined;
    }),
  );

  useEffect(() => {
    if (!syncEnabled || !activePlayer || !transport) return;

    let lastSeekAt = 0;
    // Handle state transitions: play/pause/stop
    if (transport.state === 'playing') {
      activePlayer.play().catch((err) => {
        console.warn('Failed to play:', err);
      });
      // Seek to expected position to sync with server
      const now = serverNow();
      if (!isExpectedPositionKnown(transport, now)) {
        // Clock offset is wrong: never seek to a clamped 0. Re-measure instead.
        measureClockOffsetWithRetry();
        return;
      }
      const expected = computeExpectedPosition(transport, now);
      lastSeekAt = Date.now();
      activePlayer.seekToMs(expected).catch((err) => {
        if (activePlayer.canSeek()) {
          console.warn('Failed to seek to expected position:', err);
        }
        // If !canSeek (e.g. Spotify free tier), silently continue
      });
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
        measureClockOffsetWithRetry();
        return;
      }
      // Cued/buffering/unstarted reads are unreliable (getCurrentTime() is 0).
      if (activePlayer.isPlaying && !activePlayer.isPlaying()) return;
      // Let the last seek settle before judging drift again.
      if (Date.now() - lastSeekAt < SEEK_COOLDOWN_MS) return;
      const expected = computeExpectedPosition(current, now);

      activePlayer.getCurrentPositionMs()
        .then((actual) => {
          const drift = actual - expected;
          if (shouldCorrect(drift, DRIFT_THRESHOLD_MS)) {
            lastSeekAt = Date.now();
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
