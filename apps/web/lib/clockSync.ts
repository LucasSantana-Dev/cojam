export type PingSample = {
  t0: number;
  serverNowMs: number;
  t1: number;
};

export type ClockOffset = {
  offsetMs: number;
  rttMs: number;
};

export function estimateOffset(samples: PingSample[]): ClockOffset {
  if (samples.length === 0) {
    return { offsetMs: 0, rttMs: 0 };
  }

  // Pick the sample with the smallest RTT (most reliable)
  let bestSample = samples[0];
  let minRtt = bestSample.t1 - bestSample.t0;

  for (const sample of samples.slice(1)) {
    const rtt = sample.t1 - sample.t0;
    if (rtt < minRtt) {
      minRtt = rtt;
      bestSample = sample;
    }
  }

  // NTP-lite: offset = serverNowMs - midpoint of request/response
  const midpoint = (bestSample.t0 + bestSample.t1) / 2;
  const offsetMs = bestSample.serverNowMs - midpoint;

  return {
    offsetMs,
    rttMs: minRtt,
  };
}

export function serverNow(offsetMs: number): number {
  return Date.now() + offsetMs;
}
