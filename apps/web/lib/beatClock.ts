// One shared beat for every listener (#325). The product is metadata-only, so there
// is no audio analysis: the beat is a steady clock at BPM. Aligned to the (clock
// synced) wall time, so two browsers in a room breathe on the same beat.
export const BPM = 100;
export const BEAT_MS = 60000 / BPM;

/** Beats elapsed (float) at `nowMs`, plus the fraction inside the current beat. */
export function beatAt(nowMs: number): { beats: number; phase: number; pulse: number } {
  const beats = nowMs / BEAT_MS;
  const phase = beats - Math.floor(beats);
  // quick attack, soft release: the "breath" on each beat
  const pulse = Math.exp(-phase * 4.5);
  return { beats, phase, pulse };
}
