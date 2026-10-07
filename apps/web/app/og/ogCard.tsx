import { ImageResponse } from 'next/og';
import { MARK, MARK_VIEWBOX, BADGE } from '../components/logoMark';
import { AXIS_DEFAULTS, type AxisName } from '@/lib/brandAxesConfig';

export const OG_SIZE = { width: 1200, height: 630 };

// Satori renders at the edge with no cascade, so tokens are mirrored here as hex
// (the OKLCH values live in globals.css and brand-axes.css; colorTokens.test.ts
// exempts this file).
const GROUND: Record<string, string> = {
  default: '#040407', //  --color-surface-1  oklch(0.11 0.01 280), flat ground
  black: '#040404', //    --color-surface-1 under data-ground=black
  indigo: '#0d0b24', //   --color-surface-1 under data-ground=indigo
};
const TEXT_PRIMARY = '#f0f1f9'; // --color-text-primary oklch(0.96 0.01 280)
const TEXT_SECONDARY = '#838592'; // --color-text-secondary oklch(0.62 0.02 280)
const TEXT_MUTED = '#5d5e69'; //  --color-text-muted
const INK = '#050509'; //         dark initials on ident fills
const ACCENT = '#a76ef8'; //       --color-accent (violet band)
const IDENT = ['#a06bff', '#60a5fa', '#f98acb']; // --color-ident-1..3
// Logo gradient stops, identical to icon.svg / Logo.tsx (final, do not retune).
const FRAME_FROM = '#6d5cff'; //  --logo-frame-from
const FRAME_TO = '#c661ff'; //    --logo-frame-to
const CORE_FROM = '#a3e635'; //   --logo-core-from
const CORE_TO = '#10b981'; //     --logo-core-to

export type OgAxes = Record<AxisName, string>;
export const OG_DEFAULT_AXES = { ...AXIS_DEFAULTS } as OgAxes;

const LISTENERS = [
  { n: 'A', s: 'Spotify' },
  { n: 'B', s: 'YouTube' },
  { n: 'C', s: 'Apple' },
  { n: 'D', s: 'Spotify' },
  { n: 'E', s: 'YouTube' },
  { n: 'F', s: 'Apple' },
];

function Mark({ size }: { size: number }) {
  // Two-pass paint as in Logo.tsx: whole frame first, then the core clipped to
  // the badge circle.
  return (
    <svg
      width={size}
      height={size}
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
  );
}

// Listeners joined in pairs by the headband arc (axis presence=key|all).
function Listeners() {
  const d = 44;
  const gap = 0.34;
  const arcW = d * (2 + gap);
  const arcH = d * 0.7;
  const pairs = [LISTENERS.slice(0, 2), LISTENERS.slice(2, 4), LISTENERS.slice(4, 6)];
  return (
    <div style={{ display: 'flex', position: 'absolute', right: 64, bottom: 24, alignItems: 'flex-end' }}>
      {pairs.map((pair, p) => (
        <div
          key={p}
          style={{
            display: 'flex',
            position: 'relative',
            paddingTop: arcH,
            marginLeft: p === 0 ? 0 : 18,
            marginBottom: p === 1 ? -14 : 0,
          }}
        >
          <svg
            width={arcW}
            height={arcH}
            viewBox={`0 0 ${2 + gap} 0.7`}
            style={{ position: 'absolute', left: 0, top: 0 }}
          >
            <path
              d={`M 0.5 0.76 C 0.5 -0.18, ${1.5 + gap} -0.18, ${1.5 + gap} 0.76`}
              fill="none"
              stroke={ACCENT}
              strokeWidth={0.09}
              strokeLinecap="round"
            />
          </svg>
          {pair.map((l, k) => (
            <div
              key={k}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginLeft: k === 0 ? 0 : d * gap }}
            >
              <div
                style={{
                  width: d,
                  height: d,
                  borderRadius: d,
                  background: IDENT[(p * 2 + k) % 3],
                  color: INK,
                  fontSize: 19,
                  fontWeight: 700,
                  alignItems: 'center',
                  justifyContent: 'center',
                  display: 'flex',
                }}
              >
                {l.n}
              </div>
              <div style={{ display: 'flex', marginTop: 8, fontSize: 14, color: TEXT_MUTED }}>{l.s}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Lockup({ kind }: { kind: string }) {
  const base = { display: 'flex', alignItems: 'center' } as const;
  if (kind === 'lockup-a') {
    return (
      <div style={{ ...base, gap: 24 }}>
        <Mark size={124} />
        <div style={{ display: 'flex', fontSize: 64, fontWeight: 800, color: TEXT_PRIMARY, letterSpacing: -4 }}>
          <span>Co</span>
          <span style={{ marginTop: -12 }}>J</span>
          <span>am</span>
        </div>
      </div>
    );
  }
  if (kind === 'lockup-b') {
    return (
      <div style={{ ...base, gap: 28 }}>
        <Mark size={96} />
        <div style={{ width: 2, height: 64, background: TEXT_MUTED }} />
        <div style={{ display: 'flex', fontSize: 60, fontWeight: 500, color: TEXT_PRIMARY, letterSpacing: 9 }}>CoJam</div>
      </div>
    );
  }
  if (kind === 'lockup-c') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}>
        <Mark size={130} />
        <div style={{ display: 'flex', fontSize: 52, fontWeight: 700, color: TEXT_PRIMARY, letterSpacing: -1 }}>CoJam</div>
      </div>
    );
  }
  return (
    <div style={{ ...base, gap: 28 }}>
      <Mark size={120} />
      <div style={{ display: 'flex', fontSize: 68, fontWeight: 700, color: TEXT_PRIMARY, letterSpacing: -1 }}>CoJam</div>
    </div>
  );
}

// One generic image for every route, including /room/[id]. A per-room image
// would bake the room name and now-playing into link previews, which social
// platforms cache and re-serve; for a private room that is a leak (room IDs
// are the capability, see docs/protocol.md "Trust model").
export function renderOg(axes: OgAxes = OG_DEFAULT_AXES) {
  const stacked = axes.wordmark === 'lockup-c';
  // Any non-default axis adds height (bigger lockup, listener group): tighten the
  // headline so the card still fits 630px. The default card is unchanged.
  const dense = axes.presence !== 'none' || axes.wordmark !== 'text';
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
          background: GROUND[axes.ground] ?? GROUND.default,
        }}
      >
        <Lockup kind={axes.wordmark} />

        <div
          style={{
            marginTop: stacked ? 24 : dense ? 36 : 48,
            fontSize: dense ? 62 : 78,
            lineHeight: 1.05,
            color: TEXT_PRIMARY,
            maxWidth: dense ? 1040 : 960,
          }}
        >
          Amigos em serviços de streaming diferentes, ouvindo juntos.
        </div>

        <div style={{ marginTop: 32, fontSize: 32, color: TEXT_SECONDARY, maxWidth: 900 }}>
          Spotify e YouTube numa só fila compartilhada.
        </div>
        {axes.presence !== 'none' && <Listeners />}
      </div>
    ),
    OG_SIZE,
  );
}
