// A deterministic gradient for a user avatar, derived from a stable seed (the
// member's client id, or their name as a fallback). Same seed always yields the
// same colours, so a person keeps a recognizable avatar across the room, without
// needing an uploaded picture.
//
// Hues 75 to 174 are the green band, reserved for LIVE (DESIGN.md), so both
// gradient stops skip it: an index in [0, 260) is mapped past the band.
const HUE_SLOTS = 260;
const GREEN_START = 75;
const GREEN_WIDTH = 100;

function skipGreen(i: number): number {
  return i < GREEN_START ? i : i + GREEN_WIDTH;
}

export function avatarGradient(seed: string): string {
  let i = 0;
  for (let k = 0; k < seed.length; k++) {
    i = (i * 31 + seed.charCodeAt(k)) % HUE_SLOTS;
  }
  const h = skipGreen(i);
  const h2 = skipGreen((i + 30) % HUE_SLOTS);
  return `linear-gradient(135deg, hsl(${h} 62% 56%), hsl(${h2} 68% 46%))`;
}
