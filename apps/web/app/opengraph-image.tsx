import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';
import { MARK_FRAME, MARK_DISC, MARK_VIEWBOX, FRAME_GRADIENT, CORE_GRADIENT } from './components/logoMark';

export const alt = 'CoJam · ouçam juntos, entre serviços';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Satori renders at the edge with no cascade, so tokens are mirrored here as hex
// (the OKLCH values live in globals.css; colorTokens.test.ts exempts this file).
const PLATE = 'rgba(14, 10, 27, 0.94)'; // --palco-plate oklch(0.16 0.035 292 / 0.94)
const PLATE_LINE = '#444058'; //          --palco-line over the plate, oklch(0.86 0.06 292 / 0.28)
const TEXT = '#f2f0fb'; //                 --palco-text oklch(0.96 0.015 292)
const MUTED = '#cac7dd'; //                the muted plate text oklch(0.84 0.03 292)
// Logo gradient stops, identical to Logo.tsx (hex mirrors of the OKLCH stops) (final, do not retune).
const FRAME_FROM = '#6d5cff'; //  --logo-frame-from
const FRAME_TO = '#c661ff'; //    --logo-frame-to
const CORE_FROM = '#a3e635'; //   --logo-core-from
const CORE_TO = '#10b981'; //     --logo-core-to

// The scene is the shipped palco art composed by scripts/palco-scenes/compose.py: the
// 400x210 native scene at x3 (1200x630), nearest neighbour, so Satori draws it 1:1 with no
// resampling. The HUD (the plate with the mark) is vector on top, bottom left, clear of
// the crowd on the floor. The N3 mark is the real one (decision 1), never recoloured.
async function sceneDataUri(): Promise<string> {
  const png = await readFile(path.join(process.cwd(), 'public', 'palco', 'scenes', 'og-1200.png'));
  return `data:image/png;base64,${png.toString('base64')}`;
}

// One generic image for every route, including /room/[id]. A per-room image
// would bake the room name and now-playing into link previews, which social
// platforms cache and re-serve; for a private room that is a leak (room IDs
// are the capability, see docs/protocol.md "Trust model").
export default async function OpengraphImage() {
  const scene = await sceneDataUri();
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', position: 'relative' }}>
        <img src={scene} width={1200} height={630} alt="" style={{ position: 'absolute', top: 0, left: 0 }} />
        <div
          style={{
            position: 'absolute',
            left: 36,
            bottom: 36,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            padding: '22px 26px',
            background: PLATE,
            border: `2px solid ${PLATE_LINE}`,
            borderRadius: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {/* Same two paths as Logo.tsx: frame, then the disc with the wave as a hole. */}
            <svg width={56} height={56} viewBox={MARK_VIEWBOX} xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="f" x1={FRAME_GRADIENT.x1} y1={FRAME_GRADIENT.y} x2={FRAME_GRADIENT.x2} y2={FRAME_GRADIENT.y} gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor={FRAME_FROM} />
                  <stop offset="1" stopColor={FRAME_TO} />
                </linearGradient>
                <linearGradient id="c" x1={CORE_GRADIENT.x} y1={CORE_GRADIENT.y1} x2={CORE_GRADIENT.x} y2={CORE_GRADIENT.y2} gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor={CORE_FROM} />
                  <stop offset="1" stopColor={CORE_TO} />
                </linearGradient>
              </defs>
              <path d={MARK_FRAME} fill="url(#f)" />
              <path d={MARK_DISC} fill="url(#c)" fillRule="evenodd" />
            </svg>
            <div style={{ fontSize: 48, fontWeight: 700, color: TEXT, letterSpacing: -1 }}>CoJam</div>
          </div>
          <div style={{ fontSize: 28, fontWeight: 600, color: MUTED }}>Ouçam juntos, cada um no seu app</div>
        </div>
      </div>
    ),
    size,
  );
}
