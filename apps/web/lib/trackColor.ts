// "Cor da faixa" (#325): derive one saturated ground colour from the cover that
// is playing, normalised in OKLCH so white type on it always keeps >= 4.5:1.
//
// i.ytimg.com and i.scdn.co both answer images with `access-control-allow-origin: *`,
// so a CORS-enabled <img> can be read through canvas getImageData without tainting
// it (verified with curl on both hosts). No server route and no dependency needed.

export type Tint = { l: number; c: number; h: number };

/** Violet ground shown when nothing is playing or the cover has no usable colour. */
export const IDLE_TINT: Tint = { l: 0.3, c: 0.11, h: 300 };

/** Lightness window for the ground. White text must keep >= 4.5:1 on it. */
export const TINT_L_MIN = 0.36;
export const TINT_L_MAX = 0.5;
const MIN_CONTRAST = 5.6; // headroom: secondary/muted text is white at 0.93 to 0.97 alpha, still >= 4.5

// ---- OKLab / sRGB (Bjorn Ottosson) -------------------------------------------

const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

export function rgbToOklch(r: number, g: number, b: number): Tint {
  const lr = toLin(r / 255);
  const lg = toLin(g / 255);
  const lb = toLin(b / 255);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(a, bb);
  const h = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

/** Linear sRGB for an OKLCH colour (unclamped, so callers can test the gamut). */
function oklchToLinear({ l, c, h }: Tint): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (t: Tint) => oklchToLinear(t).every((v) => v >= -0.0005 && v <= 1.0005);

/** Reduce chroma until the colour fits sRGB (so the UI never shows a clipped, shifted hue). */
export function clampToGamut(t: Tint): Tint {
  if (inGamut(t)) return t;
  let lo = 0;
  let hi = t.c;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut({ ...t, c: mid })) lo = mid;
    else hi = mid;
  }
  return { ...t, c: lo };
}

/** Gamma-encoded sRGB (0..1, clamped) of an OKLCH colour. */
export function oklchToSrgb(t: Tint): [number, number, number] {
  return oklchToLinear(t).map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  }) as [number, number, number];
}

/** WCAG contrast of white text on this colour. */
export function contrastWithWhite(t: Tint): number {
  const [r, g, b] = oklchToLinear(t).map((v) => Math.min(1, Math.max(0, v)));
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (y + 0.05);
}

/**
 * Normalise a raw cover colour into a ground: lightness clamped into the window
 * (and lowered further if white text would still fall under 4.5:1), chroma kept
 * vivid (raised to a floor, reduced only to fit the sRGB gamut).
 */
export function normalizeTint(raw: Tint): Tint {
  let l = Math.min(TINT_L_MAX, Math.max(TINT_L_MIN, raw.l));
  const c = Math.min(0.24, Math.max(0.15, raw.c * 1.15));
  let t = clampToGamut({ l, c, h: raw.h });
  while (contrastWithWhite(t) < MIN_CONTRAST && l > 0.2) {
    l -= 0.01;
    t = clampToGamut({ l, c, h: raw.h });
  }
  return t;
}

// ---- Dominant colour ----------------------------------------------------------

const BINS = 36;

/**
 * Dominant vivid colour of RGBA pixel data. Pixels that are near black (letterbox
 * bars), near white or grey are ignored; the rest vote by chroma into 10 degree
 * hue bins (a bin counts half of each neighbour so a hue split across a boundary
 * still wins). Returns null for covers with no usable colour (grayscale art).
 */
export function dominantColor(data: ArrayLike<number>): Tint | null {
  const weight = new Array<number>(BINS).fill(0);
  const sumL = new Array<number>(BINS).fill(0);
  const sumC = new Array<number>(BINS).fill(0);
  const sumX = new Array<number>(BINS).fill(0);
  const sumY = new Array<number>(BINS).fill(0);
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const { l, c, h } = rgbToOklch(data[i], data[i + 1], data[i + 2]);
    if (l < 0.22 || l > 0.94 || c < 0.05) continue;
    const w = c ** 1.5 * (1 - Math.abs(l - 0.62));
    const bin = Math.floor(h / (360 / BINS)) % BINS;
    weight[bin] += w;
    sumL[bin] += l * w;
    sumC[bin] += c * w;
    sumX[bin] += Math.cos((h * Math.PI) / 180) * w;
    sumY[bin] += Math.sin((h * Math.PI) / 180) * w;
  }
  let best = -1;
  let bestScore = 0;
  for (let b = 0; b < BINS; b++) {
    const score = weight[b] + 0.5 * (weight[(b + 1) % BINS] + weight[(b + BINS - 1) % BINS]);
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  if (best < 0 || bestScore < 0.02) return null;
  const idx = [(best + BINS - 1) % BINS, best, (best + 1) % BINS];
  let w = 0, l = 0, c = 0, x = 0, y = 0;
  for (const b of idx) {
    w += weight[b]; l += sumL[b]; c += sumC[b]; x += sumX[b]; y += sumY[b];
  }
  return { l: l / w, c: c / w, h: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 };
}

/**
 * Up to `n` distinct vivid colours of RGBA pixel data (for the mesh ground).
 * Same voting as dominantColor, but the winning hue bins are taken in order of
 * weight and must sit at least 45 degrees apart. Fewer than `n` real hues are
 * topped up with analogous shifts of the dominant one, so the mesh always has
 * variety. Returns null for grayscale art. Every colour passes normalizeTint,
 * so white text keeps its contrast on any of them.
 */
export function paletteFromPixels(data: ArrayLike<number>, n = 4): Tint[] | null {
  const weight = new Array<number>(BINS).fill(0);
  const sumL = new Array<number>(BINS).fill(0);
  const sumC = new Array<number>(BINS).fill(0);
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const { l, c, h } = rgbToOklch(data[i], data[i + 1], data[i + 2]);
    if (l < 0.22 || l > 0.94 || c < 0.05) continue;
    const w = c ** 1.5 * (1 - Math.abs(l - 0.62));
    const bin = Math.floor(h / (360 / BINS)) % BINS;
    weight[bin] += w;
    sumL[bin] += l * w;
    sumC[bin] += c * w;
  }
  const order = weight
    .map((w, b) => ({ b, score: w + 0.5 * (weight[(b + 1) % BINS] + weight[(b + BINS - 1) % BINS]) }))
    .filter((x) => x.score > 0.02)
    .sort((x, y) => y.score - x.score);
  if (order.length === 0) return null;
  const picked: Tint[] = [];
  for (const { b } of order) {
    const h = (b + 0.5) * (360 / BINS);
    if (picked.some((p) => Math.min(Math.abs(p.h - h), 360 - Math.abs(p.h - h)) < 45)) continue;
    const w = weight[b] || 1e-6;
    picked.push({ l: sumL[b] / w || 0.5, c: sumC[b] / w || 0.15, h });
    if (picked.length === n) break;
  }
  const base = picked[0];
  const shifts = [38, -38, 78, -78];
  for (let i = 0; picked.length < n && i < shifts.length; i++) {
    picked.push({ l: base.l + (i % 2 ? -0.05 : 0.05), c: base.c, h: (base.h + shifts[i] + 360) % 360 });
  }
  return picked.map(normalizeTint);
}

// ---- Image loading (browser only) ---------------------------------------------

export type CoverAnalysis = { tint: Tint; palette: Tint[] };
const cache = new Map<string, CoverAnalysis | null>();

/** Ground colour and 4-colour palette for a cover URL, or null when unreadable or colourless. */
export function analyzeImageUrl(url: string): Promise<CoverAnalysis | null> {
  if (cache.has(url)) return Promise.resolve(cache.get(url) ?? null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      let result: CoverAnalysis | null = null;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 48;
        canvas.height = 27;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          const raw = dominantColor(data);
          const palette = paletteFromPixels(data, 4);
          if (raw && palette) result = { tint: normalizeTint(raw), palette };
        }
      } catch {
        result = null; // tainted canvas (host without CORS): keep the idle ground
      }
      cache.set(url, result);
      resolve(result);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Ground colour for a cover URL, or null when the image cannot be read or has no colour. */
export async function tintFromImageUrl(url: string): Promise<Tint | null> {
  return (await analyzeImageUrl(url))?.tint ?? null;
}

export function tintStyle(t: Tint): Record<string, string> {
  return {
    '--tint-l': t.l.toFixed(3),
    '--tint-c': t.c.toFixed(3),
    '--tint-h': t.h.toFixed(1),
  };
}

export const tintCss = (t: Tint) => `oklch(${t.l.toFixed(3)} ${t.c.toFixed(3)} ${t.h.toFixed(1)})`;

const hueDist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/**
 * The two colours of the "sintonia" ground: the dominant colour and its nearest
 * distinct neighbour in the palette (between 12 and 62 degrees away), pulled back
 * towards it. When the cover has no such neighbour the second colour is the
 * dominant one shifted about 22 degrees. Both stay inside the contrast window, close in lightness and
 * chroma, so the ground reads as one soft gradient, never two competing hues.
 */
export function groundPair(tint: Tint, palette: Tint[] | null): [Tint, Tint] {
  const near = (palette ?? [])
    .map((p) => ({ p, d: hueDist(p.h, tint.h) }))
    .filter((x) => x.d >= 12 && x.d <= 62)
    .sort((a, b) => a.d - b.d)[0]?.p;
  // the neighbour's hue is pulled 45% of the way back towards the dominant one,
  // so the two colours differ by about 20 to 35 degrees: a soft gradient, not two hues
  const signed = near ? ((near.h - tint.h + 540) % 360) - 180 : 40;
  const h = (tint.h + signed * 0.55 + 360) % 360;
  const c1 = normalizeTint({ l: tint.l + 0.02, c: tint.c * 0.85, h });
  return [tint, c1];
}
