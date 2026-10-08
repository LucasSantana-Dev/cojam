'use client';

// The "sintonia" ground (#325) for every screen that is not the landing or the
// room: 404, /account, /rooms, the Spotify callback, the removed-from-room and
// error screens. Nothing is playing on these, so the ground is the idle one
// (violet), the same component the landing and the join screen use. Children sit
// on it as glass surfaces (.sx-glass); the page tokens are remapped in globals.css
// under `.sx`, the same way `.landing[data-bg="sintonia"]` does it.
import { GroundStack, type GroundSpec } from '@/app/components/GroundStack';
import { useMotion } from '@/lib/motionFlags';
import { IDLE_TINT, groundPair } from '@/lib/trackColor';

const IDLE_SPEC: GroundSpec = { palette: groundPair(IDLE_TINT, null) };

export function SintoniaScreen({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const motion = useMotion();
  return (
    <div className={`sx ${className}`.trim()} data-bg="sintonia">
      <GroundStack spec={IDLE_SPEC} animate={motion.ground} className="ground-stack--page" />
      {children}
    </div>
  );
}

/**
 * The logo's thin white sine wave, as a static line. `flat` lies it down (no
 * signal, nothing to link to); otherwise it carries `cycles` full periods.
 */
export function SineLine({ flat = false, cycles = 3, className = '' }: { flat?: boolean; cycles?: number; className?: string }) {
  const w = 120;
  const mid = 10;
  const amp = flat ? 0 : 6;
  const steps = 48;
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * w;
    const y = mid - Math.sin((i / steps) * cycles * Math.PI * 2) * amp;
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return (
    <svg className={`sx-wave ${className}`.trim()} aria-hidden="true" viewBox={`0 0 ${w} 20`} preserveAspectRatio="none">
      <path d={d} fill="none" stroke="oklch(1 0 0)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
