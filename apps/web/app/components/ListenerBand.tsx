'use client';

// Presence device from the mark: listeners (avatar = ear cup) joined in pairs by
// a band shaped like the headphone headband. Violet band, --color-ident-* fills,
// never green (green is LIVE-only). Pure presentational and decorative: callers
// pass aria-hidden context or an aria-label on the wrapper. Styles: brand-axes.css.
import type { CSSProperties } from 'react';
import { useAxis } from '@/lib/brandAxes';

export interface BandListener {
  name?: string;
  // Service label shown under the avatar when `labels` is on.
  service?: string;
}

// Arc geometry in avatar units (diameter = 1). Pair width = 2 + PAIR_GAP.
const PAIR_GAP = 0.34;
const ARC_H = 0.7;

function Arc() {
  const w = 2 + PAIR_GAP;
  const x1 = 0.5;
  const x2 = 1.5 + PAIR_GAP;
  const y = ARC_H + 0.06; // sink the ends into the cups so the band is attached
  return (
    <svg
      className="lb-arc"
      viewBox={`0 0 ${w} ${ARC_H}`}
      preserveAspectRatio="none"
      aria-hidden
      focusable="false"
    >
      <path
        d={`M ${x1} ${y} C ${x1} ${-0.18}, ${x2} ${-0.18}, ${x2} ${y}`}
        fill="none"
        stroke="var(--color-accent)"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Cup({ l, i, labels }: { l: BandListener; i: number; labels: boolean }) {
  const initial = l.name ? l.name.charAt(0).toUpperCase() : '';
  return (
    <span className="lb-cup">
      <span className="lb-av" style={{ background: `var(--color-ident-${(i % 3) + 1})` }}>
        {initial}
      </span>
      {labels && l.service && <span className="lb-svc">{l.service}</span>}
    </span>
  );
}

export function ListenerBand({
  listeners,
  size = 32,
  labels = false,
  className = '',
  stagger = false,
}: {
  listeners: BandListener[];
  size?: number;
  labels?: boolean;
  className?: string;
  // Alternate pairs vertically so a composed hero group reads as a group.
  stagger?: boolean;
}) {
  const pairs: BandListener[][] = [];
  for (let i = 0; i < listeners.length; i += 2) pairs.push(listeners.slice(i, i + 2));
  return (
    <span
      className={`lb ${className}`.trim()}
      style={{ '--lb-d': `${size}px` } as CSSProperties}
    >
      {pairs.map((pair, p) => (
        <span
          key={p}
          className="lb-pair"
          data-solo={pair.length === 1 ? '' : undefined}
          data-low={stagger && p % 2 === 1 ? '' : undefined}
        >
          {pair.length === 2 && <Arc />}
          {pair.map((l, k) => (
            <Cup key={k} l={l} i={p * 2 + k} labels={labels} />
          ))}
        </span>
      ))}
    </span>
  );
}

// Static composition for the landing hero (axis presence=key|all): six listeners
// on different services, one song. Illustrative, like the example room card.
export const HERO_LISTENERS: BandListener[] = [
  { name: 'Ana', service: 'Spotify' },
  { name: 'Bruno', service: 'YouTube' },
  { name: 'Carla', service: 'Apple' },
  { name: 'Davi', service: 'Spotify' },
  { name: 'Elisa', service: 'YouTube' },
  { name: 'Fê', service: 'Apple' },
];

export function HeroListeners() {
  return (
    <figure
      className="hero-listeners"
      role="img"
      aria-label="Seis pessoas em Spotify, YouTube e Apple Music ouvindo a mesma música"
    >
      <ListenerBand listeners={HERO_LISTENERS} size={38} labels stagger />
      <figcaption className="hero-listeners__cap">a mesma música, cada um no seu app</figcaption>
    </figure>
  );
}

// Live-room cards only know a headcount (PublicRoomSummary has no member list),
// so the avatars are anonymous: ident colour, no initial, at most four, joined by
// the band. Rendered only when presence=all; the count text stays beside it.
export function RoomBand({ count }: { count: number }) {
  const presence = useAxis('presence');
  if (presence !== 'all' || count < 1) return null;
  return (
    <span className="room-band" aria-hidden>
      <ListenerBand listeners={Array.from({ length: Math.min(count, 4) }, () => ({}))} size={20} />
    </span>
  );
}
