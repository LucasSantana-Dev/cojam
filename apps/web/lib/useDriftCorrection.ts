import { useCallback, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, requestClockRemeasure, nowPlayingAdvance, resyncRoom } from './realtime';
import { attachResumeListeners } from './backgroundPlayback';
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
// How long a catalogue-only past-end verdict waits for the player's own duration.
const PAST_END_CONFIRM_MS = 10_000;
// A player duration beyond this multiple of the catalogue entry is not trusted.
const MAX_PLAYER_DURATION_FACTOR = 3;
// A drift that moves this far between two measurements is a real jump, not a
// rebuffer: it resets the seek backoff.
const BACKOFF_RESET_DRIFT_MS = 8000;
// While the page is hidden nobody can have paused the player on purpose, so a
// paused player under a playing room is resumed again every this long (the
// browser or embed can pause it more than once).
const HIDDEN_RESUME_RETRY_MS = 5000;

export function useDriftCorrection(activePlayer: IPlayer | null, syncEnabled: boolean, canAdvance = false) {
  const driftCorrectionIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // The latest drift check, so a page coming back runs it at once (set below).
  const checkNowRef = useRef<(() => void) | null>(null);
  const canAdvanceRef = useRef(canAdvance);
  useEffect(() => {
    canAdvanceRef.current = canAdvance;
  }, [canAdvance]);
  const advancedRef = useRef<{ id: string; at: number } | null>(null);
  const transport = useStore(
    useShallow((s) => {
      const t = s.state?.transport;
      return t
        ? { state: t.state, positionMs: t.positionMs, updatedAtServerMs: t.updatedAtServerMs, hasTrack: !!s.state?.nowPlayingId }
        : undefined;
    }),
  );

  // The player's own duration for the now-playing track, learned while it
  // PLAYS (a duration read during a load is 0 or the previous video's). The
  // catalogue durationMs is a hint, not the video: a YouTube match can be a
  // longer music video, and radio refills, pasted links and video tracks carry
  // none, so the end is max(catalogue, player) and unknown means never past.
  const playerDurationRef = useRef<{ id: string; ms: number } | null>(null);
  // The hold on a catalogue-only past-end verdict: its clock starts only once
  // the player first reaches PLAYING for the track (autoplay blocked or a long
  // first buffer must not count), per track.
  const holdRef = useRef<{ id: string; at: number } | null>(null);
  // True while the last handlePastEnd call is only holding (not decided): the
  // caller must still let a paused player resume, but never seek.
  const holdingRef = useRef(false);
  // Track id the player has been seen PLAYING for.
  const playedRef = useRef<string | null>(null);

  // Reads the player's duration into playerDurationRef, only while it PLAYS.
  const learnDuration = useCallback(() => {
    if (!activePlayer) return;
    if (activePlayer.isPlaying && !activePlayer.isPlaying()) return;
    const id = useStore.getState().state?.nowPlayingId;
    if (!id) return;
    playedRef.current = id;
    activePlayer
      .getDurationMs()
      .then((ms) => {
        if (Number.isFinite(ms) && ms > 0) playerDurationRef.current = { id, ms };
      })
      .catch(() => {});
  }, [activePlayer]);

  // Returns true when the transport is past the end of the now-playing track
  // (the caller must not seek); advances once if this user can control.
  const handlePastEnd = useCallback((current: { state: 'playing' | 'paused' | 'stopped'; positionMs: number; updatedAtServerMs: number }, now: number): boolean => {
    const st = useStore.getState().state;
    const id = st?.nowPlayingId;
    holdingRef.current = false;
    if (!st || !id) return false;
    learnDuration();
    const catalogueMs = st.queue.find((t) => t.id === id)?.durationMs ?? 0;
    const learned = playerDurationRef.current;
    let playerMs = learned && learned.id === id ? learned.ms : 0;
    // A player length far beyond the entry is a wrong match (hour-long loop),
    // not a longer cut: the catalogue end stands.
    if (catalogueMs > 0 && playerMs > catalogueMs * MAX_PLAYER_DURATION_FACTOR) playerMs = 0;
    const durationMs = Math.max(catalogueMs, playerMs);
    if (!isPastEnd(current, now, durationMs)) {
      holdRef.current = null;
      return false;
    }
    // Only the catalogue says the track ended and the player has not told us
    // its length yet (metadata still loading): hold, no seek, no advance, until
    // it does, bounded so a stale room whose player never starts still moves.
    if (activePlayer && playerMs === 0) {
      // Not PLAYING yet (autoplay blocked, long first buffer): keep holding, the
      // server's AdvanceIfEnded covers a truly stale room.
      if (playedRef.current !== id) {
        holdingRef.current = true;
        return true;
      }
      const hold = holdRef.current && holdRef.current.id === id ? holdRef.current : (holdRef.current = { id, at: Date.now() });
      if (Date.now() - hold.at < PAST_END_CONFIRM_MS) {
        holdingRef.current = true;
        return true;
      }
    }
    const last = advancedRef.current;
    if (canAdvanceRef.current && (!last || last.id !== id || Date.now() - last.at > ADVANCE_RETRY_MS)) {
      advancedRef.current = { id, at: Date.now() };
      nowPlayingAdvance(st.roomId, id).catch((err) => {
        console.warn('Failed to advance past a track that already ended:', err);
      });
    }
    return true;
  }, [activePlayer, learnDuration]);

  useEffect(() => {
    if (!syncEnabled || !activePlayer || !transport) return;

    let lastSeekAt = 0;
    // Corrective seeks in a row without drift settling (see seekCooldownMs).
    let consecutiveSeeks = 0;
    // Previous measured drift: only a CHANGE of the offset resets the backoff, a
    // persistent large offset keeps backing off.
    let lastDrift = 0;
    let resumeTried = false;
    let lastResumeAt = 0;
    // Queue ended: the server leaves the transport "playing" at 0 with nothing
    // now-playing, while an adapter may still hold the finished track. Resuming
    // and seeking it to 0 would replay that song instead of waiting for the
    // radio refill, so there is nothing to sync until a track is set.
    if (transport.state === 'playing' && !transport.hasTrack) return;
    // Handle state transitions: play/pause/stop
    if (transport.state === 'playing') {
      // Same store snapshot for the transport and the now-playing id.
      const now = serverNow();
      if (handlePastEnd(useStore.getState().state?.transport ?? transport, now)) {
        // Past the end: no seek (see the header comment); a listener waits for
        // the room to move. While only holding for the player's own duration
        // the player must still start, or it never reports one.
        if (holdingRef.current) {
          activePlayer.play().catch((err) => {
            console.warn('Failed to play:', err);
          });
        }
      } else if (isExpectedPositionKnown(transport, now)) {
        activePlayer.play().catch((err) => {
          console.warn('Failed to play:', err);
        });
        const expected = computeExpectedPosition(transport, now);
        lastSeekAt = Date.now();
        activePlayer.seekToMs(expected).catch((err) => {
          if (activePlayer.canSeek()) {
            console.warn('Failed to seek to expected position:', err);
          }
          // If !canSeek (e.g. Spotify free tier), silently continue
        });
      } else {
        activePlayer.play().catch((err) => {
          console.warn('Failed to play:', err);
        });
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
    const check = () => {
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
      const pastEnd = handlePastEnd(current, now);
      if (pastEnd && !holdingRef.current) return;
      // Cued/buffering/unstarted reads are unreliable (getCurrentTime() is 0).
      if (activePlayer.isPlaying && !activePlayer.isPlaying()) {
        // Paused while the room plays (e.g. autoplay blocked): try play() once
        // per transport change, never in a loop.
        const retryHidden = typeof document !== 'undefined' && document.hidden && Date.now() - lastResumeAt > HIDDEN_RESUME_RETRY_MS;
        if ((!resumeTried || retryHidden) && activePlayer.isPaused?.()) {
          resumeTried = true;
          lastResumeAt = Date.now();
          activePlayer.play().catch(() => {});
        }
        return;
      }
      if (pastEnd) return; // holding for the player's duration: resume above, never seek
      const expected = computeExpectedPosition(current, now);

      activePlayer.getCurrentPositionMs()
        .then((actual) => {
          const drift = actual - expected;
          const previousDrift = lastDrift;
          lastDrift = drift;
          if (!shouldCorrect(drift, DRIFT_THRESHOLD_MS)) {
            consecutiveSeeks = 0;
          } else {
            // Drift is measured every tick; only the SEEK waits for the last one
            // to settle. A large new jump is not a rebuffer: back to the base wait.
            if (Math.abs(drift - previousDrift) > BACKOFF_RESET_DRIFT_MS) consecutiveSeeks = 0;
            if (Date.now() - lastSeekAt < seekCooldownMs(consecutiveSeeks)) return;
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
    };
    driftCorrectionIntervalRef.current = setInterval(check, 1500);
    // Coming back to the page: the throttled tick may be a minute away, so check
    // now, with a fresh chance to resume a paused player.
    checkNowRef.current = () => {
      resumeTried = false;
      check();
    };

    return () => {
      checkNowRef.current = null;
      if (driftCorrectionIntervalRef.current) {
        clearInterval(driftCorrectionIntervalRef.current);
        driftCorrectionIntervalRef.current = null;
      }
    };
  }, [activePlayer, transport, syncEnabled, handlePastEnd]);

  // The page came back (shown, thawed, online): adopt the server state, then
  // check the player against it immediately. Never pauses anything.
  useEffect(() => {
    return attachResumeListeners(() => {
      void resyncRoom();
      checkNowRef.current?.();
    });
  }, []);
}
