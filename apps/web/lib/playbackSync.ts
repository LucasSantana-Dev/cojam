import { getClockOffsetMs } from './realtime';

/**
 * Drift correction threshold in milliseconds.
 * Set above the ~500ms cross-service physics floor to avoid constant thrashing
 * when natural clock drift is within provider variance tolerances.
 * Clients only seek when actual drift exceeds this threshold.
 */
export const DRIFT_THRESHOLD_MS = 1000;

/**
 * Get the current server time adjusted for client clock offset.
 * Used to compute expected position in the playback timeline.
 */
export function serverNow(): number {
  return Date.now() + getClockOffsetMs();
}

/**
 * Compute the expected playback position based on transport state and server time.
 * @param transport The current transport state from the room (may be undefined)
 * @param serverNowMs Current server time in milliseconds
 * @returns Expected position in milliseconds, never negative
 */
export function computeExpectedPosition(
  transport: { state: 'playing' | 'paused' | 'stopped'; positionMs: number; updatedAtServerMs: number } | undefined,
  serverNowMs: number,
): number {
  if (!transport) return 0;

  if (transport.state === 'stopped') return 0;
  if (transport.state === 'paused') return transport.positionMs;

  // Playing: position advances by elapsed time since the last update
  const elapsedMs = serverNowMs - transport.updatedAtServerMs;
  const expected = transport.positionMs + elapsedMs;
  return Math.max(0, expected);
}

/**
 * Determine if the actual playback position deviates enough from expected
 * to warrant a seek correction.
 * @param driftMs Difference between actual and expected position (can be negative)
 * @param thresholdMs Tolerance threshold in milliseconds
 * @returns true if absolute drift exceeds threshold, false otherwise
 */
export function shouldCorrect(driftMs: number, thresholdMs: number): boolean {
  return Math.abs(driftMs) > thresholdMs;
}

/**
 * Tolerance for a "future" updatedAtServerMs. Real jitter is a few hundred ms;
 * anything beyond this means our clock offset is wrong (never measured, or the
 * client clock is far behind), so the expected position is unknown, not 0.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 2000;

/**
 * True when the expected position can be trusted. A playing transport stamped
 * well in the future of our corrected clock yields a negative elapsed time that
 * computeExpectedPosition clamps to 0; seeking there restarts the track.
 */
export function isExpectedPositionKnown(
  transport: { state: 'playing' | 'paused' | 'stopped'; positionMs: number; updatedAtServerMs: number } | undefined,
  serverNowMs: number,
): boolean {
  if (!transport || transport.state !== 'playing') return true;
  return serverNowMs - transport.updatedAtServerMs >= -CLOCK_SKEW_TOLERANCE_MS;
}

/** Minimum gap between corrective seeks, so a seek can settle before re-measuring. */
export const SEEK_COOLDOWN_MS = 3000;
