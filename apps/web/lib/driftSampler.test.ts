import { describe, it, expect } from 'vitest';
import { createDriftSampler, DRIFT_SAMPLE_INTERVAL_MS, DRIFT_TRACK_CHANGE_DELAY_MS } from './driftSampler';

// Drives the sampler like the hook does: poll due() each second, call sent()
// when it says yes. Returns the times (ms) at which a sample was taken.
function run(sampler: ReturnType<typeof createDriftSampler>, key: string | null, from: number, to: number, hook?: (t: number) => void) {
  const out: number[] = [];
  for (let t = from; t <= to; t += 1000) {
    hook?.(t);
    if (sampler.due(key, t)) {
      sampler.sent(t);
      out.push(t);
    }
  }
  return out;
}

describe('createDriftSampler', () => {
  it('samples once about 3 s after the first track, then every 30 s', () => {
    const s = createDriftSampler();
    const t0 = 1_000_000;
    const at = run(s, 'a', t0, t0 + 95_000);
    expect(at[0] - t0).toBe(DRIFT_TRACK_CHANGE_DELAY_MS);
    expect(at.slice(1).map((t, i) => t - at[i])).toEqual([30_000, 30_000, 30_000]);
  });

  it('samples again about 3 s after a track change and restarts the cadence', () => {
    const s = createDriftSampler();
    const t0 = 2_000_000;
    run(s, 'a', t0, t0 + 10_000);
    const t1 = t0 + 12_000;
    const at = run(s, 'b', t1, t1 + 40_000);
    expect(at[0] - t1).toBe(DRIFT_TRACK_CHANGE_DELAY_MS);
    expect(at[1] - at[0]).toBe(DRIFT_SAMPLE_INTERVAL_MS);
  });

  it('owes one sample after a forced delay (seek or resume)', () => {
    const s = createDriftSampler();
    const t0 = 3_000_000;
    run(s, 'a', t0, t0 + 5000);
    s.force(1500, t0 + 10_000);
    expect(s.due('a', t0 + 10_500)).toBe(false);
    expect(s.due('a', t0 + 11_500)).toBe(true);
    s.sent(t0 + 11_500);
    expect(s.due('a', t0 + 12_500)).toBe(false);
  });

  it('never samples faster than the 3 s floor, even with back-to-back forces', () => {
    const s = createDriftSampler();
    const t0 = 4_000_000;
    run(s, 'a', t0, t0 + 5000);
    const times: number[] = [];
    for (let t = t0 + 6000; t < t0 + 20_000; t += 500) {
      s.force(0, t);
      if (s.due('a', t)) {
        s.sent(t);
        times.push(t);
      }
    }
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(3000);
  });

  it('is silent with no track', () => {
    const s = createDriftSampler();
    expect(run(s, null, 0, 120_000)).toEqual([]);
  });
});
