// Demo tracks for the landing device (#325). Fictional on purpose: the hero must
// not borrow real artists' names or covers. Each hue goes through the same
// normalisation as a real cover colour, so the demo shows exactly what a room gets.
import { normalizeTint, oklchToSrgb, tintStyle, type Tint } from './trackColor';

export type DemoTrack = { title: string; artist: string; tint: Tint; palette: Tint[]; hues: [number, number, number] };

const make = (title: string, artist: string, hues: [number, number, number]): DemoTrack => ({
  title,
  artist,
  hues,
  tint: normalizeTint({ l: 0.55, c: 0.2, h: hues[0] }),
  palette: [hues[0], hues[1], hues[2], (hues[0] + 180) % 360 === hues[1] ? hues[2] : (hues[1] + hues[2]) / 2].map((h, i) =>
    normalizeTint({ l: 0.5 - i * 0.02, c: 0.2, h }),
  ),
});

export const DEMO_TRACKS: readonly DemoTrack[] = [
  make('Maré Alta', 'Luma Vaz', [28, 340, 62]),
  make('Neon Domingo', 'Ravi Costa', [195, 150, 265]),
  make('Vidro Fosco', 'Tati Ramos', [268, 320, 200]),
  make('Calor de Março', 'Duo Sereno', [350, 40, 285]),
];

export const DEMO_CYCLE_MS = 5200;
export const demoTintStyle = (i: number) => tintStyle(DEMO_TRACKS[i % DEMO_TRACKS.length].tint);

const hex = (t: Tint) =>
  '#' +
  oklchToSrgb(t)
    .map((v) => Math.round(v * 255).toString(16).padStart(2, '0'))
    .join('');

/**
 * Abstract demo cover (SVG data URI): a diagonal gradient, a large disc, a ring
 * and a small bright disc in three hues, so the ground built from it is
 * multi-colour like a real cover and never one flat hue.
 */
export function demoCover(i: number): string {
  const [h0, h1, h2] = DEMO_TRACKS[i % DEMO_TRACKS.length].hues;
  const a = hex({ l: 0.62, c: 0.22, h: h0 });
  const b = hex({ l: 0.38, c: 0.2, h: h1 });
  const c = hex({ l: 0.78, c: 0.17, h: h2 });
  const d = hex({ l: 0.92, c: 0.08, h: h0 });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>` +
    `<rect width="600" height="600" fill="url(#g)"/>` +
    `<circle cx="210" cy="400" r="230" fill="${c}"/>` +
    `<circle cx="210" cy="400" r="150" fill="none" stroke="${b}" stroke-width="26"/>` +
    `<circle cx="430" cy="170" r="70" fill="${d}"/>` +
    `<rect x="330" y="330" width="360" height="90" rx="45" transform="rotate(-32 330 330)" fill="${b}" opacity=".85"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
