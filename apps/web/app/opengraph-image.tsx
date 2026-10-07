import { ImageResponse } from 'next/og';
import { MARK, MARK_VIEWBOX, BADGE } from './components/logoMark';

export const alt = 'CoJam · ouçam juntos, entre serviços';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Satori renders at the edge with no cascade, so tokens are mirrored here as hex
// (the OKLCH values live in globals.css; colorTokens.test.ts exempts this file).
const SURFACE_1 = '#040407'; //    --color-surface-1  oklch(0.11 0.01 280), flat ground
const TEXT_PRIMARY = '#f0f1f9'; // --color-text-primary oklch(0.96 0.01 280)
const TEXT_SECONDARY = '#838592'; // --color-text-secondary oklch(0.62 0.02 280)
// Logo gradient stops, identical to icon.svg / Logo.tsx (final, do not retune).
const FRAME_FROM = '#6d5cff'; //  --logo-frame-from
const FRAME_TO = '#c661ff'; //    --logo-frame-to
const CORE_FROM = '#a3e635'; //   --logo-core-from
const CORE_TO = '#10b981'; //     --logo-core-to

// One generic image for every route, including /room/[id]. A per-room image
// would bake the room name and now-playing into link previews, which social
// platforms cache and re-serve; for a private room that is a leak (room IDs
// are the capability, see docs/protocol.md "Trust model").
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '80px',
          background: SURFACE_1,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
          {/* Two-pass paint as in Logo.tsx: whole frame first, then the core
              clipped to the badge circle. */}
          <svg
            width={120}
            height={120}
            viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <linearGradient id="f" x1="20" y1="439" x2="858" y2="439" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor={FRAME_FROM} />
                <stop offset="1" stopColor={FRAME_TO} />
              </linearGradient>
              <linearGradient id="c" x1="439" y1="360" x2="439" y2="720" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor={CORE_FROM} />
                <stop offset="1" stopColor={CORE_TO} />
              </linearGradient>
              <clipPath id="b">
                <circle cx={BADGE.cx} cy={BADGE.cy} r={BADGE.r} />
              </clipPath>
            </defs>
            <path d={MARK} fill="url(#f)" fillRule="evenodd" />
            <path d={MARK} fill="url(#c)" fillRule="evenodd" clipPath="url(#b)" />
          </svg>
          <div style={{ fontSize: 68, fontWeight: 700, color: TEXT_PRIMARY, letterSpacing: -1 }}>CoJam</div>
        </div>

        <div
          style={{
            marginTop: 48,
            fontSize: 78,
            lineHeight: 1.05,
            color: TEXT_PRIMARY,
            maxWidth: 960,
          }}
        >
          Amigos em serviços de streaming diferentes, ouvindo juntos.
        </div>

        <div style={{ marginTop: 32, fontSize: 32, color: TEXT_SECONDARY, maxWidth: 900 }}>
          Spotify e YouTube numa só fila compartilhada.
        </div>
      </div>
    ),
    size,
  );
}
