import { describe, expect, it } from 'vitest';
import {
  TINT_L_MAX,
  TINT_L_MIN,
  clampToGamut,
  contrastWithWhite,
  dominantColor,
  normalizeTint,
  oklchToSrgb,
  rgbToOklch,
} from './trackColor';

const px = (r: number, g: number, b: number, n = 50) => Array.from({ length: n }, () => [r, g, b, 255]).flat();

describe('normalizeTint', () => {
  it('keeps white text above 4.5:1 for every hue and cover lightness', () => {
    for (let h = 0; h < 360; h += 10) {
      for (const l of [0.1, 0.4, 0.7, 0.95]) {
        const t = normalizeTint({ l, c: 0.3, h });
        expect(contrastWithWhite(t)).toBeGreaterThanOrEqual(4.5);
        expect(t.l).toBeGreaterThanOrEqual(0.2);
        expect(t.l).toBeLessThanOrEqual(TINT_L_MAX);
      }
    }
  });

  it('keeps the colour vivid and inside sRGB', () => {
    const t = normalizeTint({ l: 0.6, c: 0.02, h: 150 });
    expect(t.c).toBeGreaterThan(0.1);
    expect(clampToGamut(t)).toEqual(t);
    expect(TINT_L_MIN).toBeLessThan(TINT_L_MAX);
  });
});

describe('dominantColor', () => {
  it('picks the vivid hue and ignores black letterbox bars and grey', () => {
    const data = [...px(0, 0, 0, 400), ...px(128, 128, 128, 400), ...px(220, 40, 60, 80), ...px(40, 90, 220, 20)];
    const c = dominantColor(data);
    expect(c).not.toBeNull();
    const red = rgbToOklch(220, 40, 60);
    expect(Math.abs(c!.h - red.h)).toBeLessThan(15);
  });

  it('returns null for grayscale art', () => {
    expect(dominantColor([...px(10, 10, 10), ...px(240, 240, 240), ...px(120, 120, 120)])).toBeNull();
  });

  it('ignores transparent pixels', () => {
    expect(dominantColor([255, 0, 0, 0, 255, 0, 0, 10])).toBeNull();
  });
});

describe('text tokens on the tinted room (globals.css "Cor da faixa")', () => {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  // CSS composites alpha in gamma-encoded sRGB.
  const over = (bg: number[], alpha: number) => bg.map((v) => alpha + (1 - alpha) * v);
  const ratio = (fg: number[], bg: number[]) => (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);

  it('muted (0.93) and secondary (0.97) white keep 4.5:1 on panels at every hue and at the lightest allowed ground', () => {
    for (let h = 0; h < 360; h += 15) {
      const g = normalizeTint({ l: 0.9, c: 0.3, h }); // lightest ground the normaliser can emit
      // .panel = tint -0.13 L, 0.85 C at 0.82 alpha over the ground
      const panel = oklchToSrgb({ l: g.l - 0.13, c: g.c * 0.85, h });
      const ground = oklchToSrgb(g);
      const bg = panel.map((v, i) => 0.82 * v + 0.18 * ground[i]);
      expect(ratio(over(bg, 0.93), bg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(over(bg, 0.97), bg)).toBeGreaterThanOrEqual(4.5);
      // text straight on the ground (header, stage band)
      expect(ratio(over(ground, 0.93), ground)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('paletteFromPixels', () => {
  const mix = [...px(220, 40, 60, 60), ...px(40, 120, 220, 50), ...px(240, 200, 30, 40), ...px(0, 0, 0, 100)];
  it('returns four distinct, contrast-safe colours from a multi-colour cover', async () => {
    const { paletteFromPixels, contrastWithWhite: cw } = await import('./trackColor');
    const p = paletteFromPixels(mix, 4)!;
    expect(p).toHaveLength(4);
    for (const t of p) expect(cw(t)).toBeGreaterThanOrEqual(4.5);
    const hues = p.map((t) => t.h);
    expect(new Set(hues.map((h) => Math.round(h / 20))).size).toBeGreaterThanOrEqual(3);
  });
  it('tops up a single-hue cover with analogous colours and returns null for grey', async () => {
    const { paletteFromPixels } = await import('./trackColor');
    expect(paletteFromPixels(px(40, 120, 220, 200), 4)).toHaveLength(4);
    expect(paletteFromPixels(px(120, 120, 120, 200), 4)).toBeNull();
  });
});

describe('groundPair', () => {
  it('takes the nearest neighbour within 62 degrees, contrast-safe', async () => {
    const { groundPair, normalizeTint: nt, contrastWithWhite: cw } = await import('./trackColor');
    const dom = nt({ l: 0.5, c: 0.2, h: 20 });
    const [a, b] = groundPair(dom, [dom, nt({ l: 0.5, c: 0.2, h: 200 }), nt({ l: 0.5, c: 0.2, h: 55 })]);
    expect(a).toBe(dom);
    expect(Math.abs(b.h - 39)).toBeLessThan(5);
    expect(cw(b)).toBeGreaterThanOrEqual(4.5);
  });
  it('synthesises a close neighbour when the cover has none', async () => {
    const { groundPair, normalizeTint: nt } = await import('./trackColor');
    const dom = nt({ l: 0.5, c: 0.2, h: 100 });
    const [, b] = groundPair(dom, null);
    expect(Math.abs(b.h - 122)).toBeLessThan(5);
  });
});
