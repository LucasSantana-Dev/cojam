import { describe, expect, it } from "vitest";
import { avatarGradient } from "./avatar";

const FORMAT =
  /^linear-gradient\(135deg, hsl\((\d+) 62% 56%\), hsl\((\d+) 68% 46%\)\)$/;

describe("avatarGradient", () => {
  it("never uses a hue in the LIVE green band (75 to 174)", () => {
    for (let n = 0; n < 5000; n++) {
      const seed = `member-${n}-${(n * 7919).toString(36)}`;
      const m = FORMAT.exec(avatarGradient(seed));
      expect(m, seed).not.toBeNull();
      for (const raw of [m![1], m![2]]) {
        const hue = Number(raw);
        expect(hue >= 75 && hue <= 174, `${seed} -> ${hue}`).toBe(false);
        expect(hue).toBeGreaterThanOrEqual(0);
        expect(hue).toBeLessThan(360);
      }
    }
  });

  it("is deterministic for the same seed", () => {
    expect(avatarGradient("abc")).toBe(avatarGradient("abc"));
  });
});
