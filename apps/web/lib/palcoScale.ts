// Integer scale for the palco scene art: the largest k with nativeW * k <= availW,
// never below 1. The art is drawn on one fixed grid and only ever scaled by whole
// numbers (DESIGN.md, "Palco on every screen").
export function pickScale(nativeW: number, availW: number): number {
  if (!(nativeW > 0) || !(availW > 0)) return 1;
  return Math.max(1, Math.floor(availW / nativeW));
}
