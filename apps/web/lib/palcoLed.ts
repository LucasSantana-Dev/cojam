// The 5x7 LED bitmap font of the stage screens, as drawn by scripts/palco-scenes/compose.py
// (palcoLed.test.ts pins the two together). The wave 2 screens show real data (the room
// code, the page name), so the text is drawn in the DOM, from rects, at the same integer
// scale as the scene art around it: crisp, no webfont, never smoothed.

export const LED_GLYPHS: Record<string, readonly string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ' ': ['000', '000', '000', '000', '000', '000', '000'],
  '.': ['0', '0', '0', '0', '0', '0', '1'],
};

/** Upper case, accents stripped, anything the font lacks becomes a space. */
export function ledNormalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 .]/g, ' ');
}

/** Width in native pixels at scale k (one pixel of tracking between glyphs). */
export function ledWidth(text: string, k = 1): number {
  let w = 0;
  for (const c of text) w += (LED_GLYPHS[c]?.[0]?.length ?? 3) + 1;
  return Math.max(0, w - 1) * k;
}

export interface LedSpec {
  title: string;
  /** Wanted title scale, 1 to 3. It steps down until the text fits the screen. */
  scale?: 1 | 2 | 3;
  sub?: string;
  /** The sub line is violet by default; white for data (a room code). */
  subTone?: 'violet' | 'white';
}

export interface LedLine { text: string; k: number; x: number; y: number }
export interface LedLayout { title: LedLine; sub?: LedLine; subTone: 'violet' | 'white' }

const MARGIN = 8;

/** Longest prefix of text that fits maxW at scale 1, ending in "." when cut. */
function clip(text: string, maxW: number): string {
  if (ledWidth(text) <= maxW) return text;
  let out = text;
  while (out.length > 1 && ledWidth(`${out}.`) > maxW) out = out.slice(0, -1);
  return `${out.trimEnd()}.`;
}

/**
 * Centre a title (and an optional 1x sub line) on a screen of w x h native pixels,
 * the layout the boards use: the pair is centred as one block, 6 pixels apart.
 */
export function ledLayout(w: number, h: number, spec: LedSpec): LedLayout {
  const maxW = w - MARGIN;
  const text = ledNormalize(spec.title).trim();
  let k: number = spec.scale ?? 1;
  while (k > 1 && ledWidth(text, k) > maxW) k -= 1;
  const title = ledWidth(text, k) > maxW ? clip(text, maxW) : text;
  const sub = spec.sub ? clip(ledNormalize(spec.sub).trim(), maxW) : undefined;
  const y = Math.floor((h - 7 * k - (sub ? 12 : 0)) / 2);
  return {
    title: { text: title, k, x: Math.floor((w - ledWidth(title, k)) / 2), y },
    sub: sub ? { text: sub, k: 1, x: Math.floor((w - ledWidth(sub, 1)) / 2), y: y + 7 * k + 6 } : undefined,
    subTone: spec.subTone ?? 'violet',
  };
}

/** One SVG path of unit squares scaled by k: every lit pixel of the text. */
export function ledPath(line: LedLine): string {
  let d = '';
  let x = line.x;
  for (const c of line.text) {
    const g = LED_GLYPHS[c] ?? LED_GLYPHS[' '];
    g.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        if (row[i] === '1') d += `M${x + i * line.k} ${line.y + j * line.k}h${line.k}v${line.k}h-${line.k}z`;
      }
    });
    x += (g[0].length + 1) * line.k;
  }
  return d;
}
