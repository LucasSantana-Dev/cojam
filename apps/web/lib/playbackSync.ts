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
