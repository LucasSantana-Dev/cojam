import { ImageResponse } from 'next/og';

export const alt = 'CoJam · listen together, across services';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

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
          background: '#0a0a0f',
          backgroundImage:
            'radial-gradient(circle at 15% 15%, rgba(109,92,255,0.35), transparent 55%), radial-gradient(circle at 85% 80%, rgba(16,185,129,0.28), transparent 55%)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 999,
              background: 'linear-gradient(180deg, #a3e635, #10b981)',
            }}
          />
          <div style={{ fontSize: 34, color: '#c4b5fd', letterSpacing: 2 }}>COJAM</div>
        </div>

        <div
          style={{
            marginTop: 36,
            fontSize: 82,
            lineHeight: 1.05,
            color: '#fafafa',
            maxWidth: 940,
          }}
        >
          Friends on different streaming services, listening together.
        </div>

        <div style={{ marginTop: 32, fontSize: 32, color: '#a1a1aa', maxWidth: 900 }}>
          Spotify, Apple Music and YouTube in one shared queue.
        </div>
      </div>
    ),
    size,
  );
}
