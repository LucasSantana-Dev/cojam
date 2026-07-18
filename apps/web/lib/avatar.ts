// A deterministic gradient for a user avatar, derived from a stable seed (the
// member's client id, or their name as a fallback). Same seed always yields the
// same colours, so a person keeps a recognizable avatar across the room, without
// needing an uploaded picture.
export function avatarGradient(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) % 360;
  }
  const h2 = (h + 42) % 360;
  return `linear-gradient(135deg, hsl(${h} 62% 56%), hsl(${h2} 68% 46%))`;
}
