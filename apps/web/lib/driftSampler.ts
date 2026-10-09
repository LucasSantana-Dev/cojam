// Cadence for the sync_drift telemetry sample. Pure scheduling, no I/O: the
// hook asks `due()` cheaply every second and only reads the player position
// when a sample is actually owed.
//
// Samples: every 30 s while playing, once ~3 s after a track change, and one
// forced shortly after a corrective seek or a page resume (the moments the
// drift is most informative). A 3 s floor between any two samples keeps the
// client under the server's /api/telemetry bucket (20 burst, one per 3 s).

export const DRIFT_SAMPLE_INTERVAL_MS = 30_000;
export const DRIFT_TRACK_CHANGE_DELAY_MS = 3_000;
export const DRIFT_MIN_GAP_MS = 3_000;

export type DriftSampler = {
  /** True when a sample should be taken now. `trackKey` only detects a change and is never sent. */
  due(trackKey: string | null, now?: number): boolean;
  /** Records that a sample was sent. */
  sent(now?: number): void;
  /** Owes one sample `delayMs` from now (after a seek or a resume). */
  force(delayMs: number, now?: number): void;
};

export function createDriftSampler(): DriftSampler {
  let lastSentAt = 0;
  let trackKey: string | null = null;
  let trackSince = 0;
  let trackSampled = true;
  let forcedAt: number | null = null;

  return {
    due(key, now = Date.now()) {
      if (key !== trackKey) {
        trackKey = key;
        trackSince = now;
        trackSampled = key === null;
        // A new track restarts the 30 s cadence from the change.
        lastSentAt = now;
      }
      if (key === null) return false;
      if (now - lastSentAt < DRIFT_MIN_GAP_MS) return false;
      if (forcedAt !== null && now >= forcedAt) return true;
      if (!trackSampled && now - trackSince >= DRIFT_TRACK_CHANGE_DELAY_MS) return true;
      return now - lastSentAt >= DRIFT_SAMPLE_INTERVAL_MS;
    },
    sent(now = Date.now()) {
      lastSentAt = now;
      trackSampled = true;
      forcedAt = null;
    },
    force(delayMs, now = Date.now()) {
      forcedAt = now + delayMs;
    },
  };
}
