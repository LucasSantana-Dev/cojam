// Generates the PWA icons in public/icons/ from the real N3 geometry in
// app/components/logoMark.ts (same paths and gradients as Logo.tsx and
// opengraph-image.tsx; never redrawn, never recoloured). Uses next/og, already a
// dependency, so there is no new tooling. Run: node scripts/gen-pwa-icons.mjs
// (Node 22+, reads the .ts module through type stripping). Output is committed.
import { createElement as h } from 'react';
import { ImageResponse } from 'next/og.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as M from '../app/components/logoMark.ts';

const INK = '#0d0a17'; // palco ink, the app ground
const FRAME_FROM = '#6d5cff';
const FRAME_TO = '#c661ff';
const CORE_FROM = '#a3e635';
const CORE_TO = '#10b981';
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');

// `fill` = share of the canvas the 240-unit mark box takes. Maskable icons keep
// the mark inside the 80% safe zone (a 72% box leaves margin for the circle crop).
async function render(name, px, fill) {
  const inner = Math.round(px * fill);
  const small = inner <= M.MARK_SMALL_MAX;
  const frame = small ? M.MARK_FRAME_SMALL : M.MARK_FRAME;
  const disc = small ? M.MARK_DISC_SMALL : M.MARK_DISC;
  const core = small ? M.CORE_GRADIENT_SMALL : M.CORE_GRADIENT;
  const svg = h(
    'svg',
    { width: inner, height: inner, viewBox: M.MARK_VIEWBOX, xmlns: 'http://www.w3.org/2000/svg' },
    h('defs', null,
      h('linearGradient', { id: 'f', x1: M.FRAME_GRADIENT.x1, y1: M.FRAME_GRADIENT.y, x2: M.FRAME_GRADIENT.x2, y2: M.FRAME_GRADIENT.y, gradientUnits: 'userSpaceOnUse' },
        h('stop', { offset: 0, stopColor: FRAME_FROM }), h('stop', { offset: 1, stopColor: FRAME_TO })),
      h('linearGradient', { id: 'c', x1: core.x, y1: core.y1, x2: core.x, y2: core.y2, gradientUnits: 'userSpaceOnUse' },
        h('stop', { offset: 0, stopColor: CORE_FROM }), h('stop', { offset: 1, stopColor: CORE_TO }))),
    h('path', { d: frame, fill: 'url(#f)' }),
    h('path', { d: disc, fill: 'url(#c)', fillRule: 'evenodd' }));
  const res = new ImageResponse(
    h('div', { style: { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: INK } }, svg),
    { width: px, height: px });
  await writeFile(path.join(out, name), Buffer.from(await res.arrayBuffer()));
  console.log('wrote', name, px, 'mark', inner);
}

await mkdir(out, { recursive: true });
await render('icon-192.png', 192, 0.8);
await render('icon-512.png', 512, 0.8);
await render('icon-maskable-512.png', 512, 0.64);
