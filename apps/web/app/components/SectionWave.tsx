'use client';

// A sine line that draws itself between two listeners at a section break
// (#325, motion moment 3). Uses GSAP DrawSVGPlugin (shipped in the installed
// gsap 3.15). Under reduced motion it renders already drawn.
import { useEffect, useRef } from 'react';
import { beatAt } from '@/lib/beatClock';

const W = 800;
const H = 72;
const X0 = 78;
const X1 = W - 78;

function sinePath(): string {
  const pts: string[] = [];
  const n = 120;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = X0 + (X1 - X0) * t;
    // amplitude eases in and out so the line leaves each avatar flat
    const env = Math.sin(Math.PI * t) ** 0.6;
    const y = H / 2 + Math.sin(t * Math.PI * 7) * 15 * env;
    pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return pts.join(' ');
}
const PATH = sinePath();

export function SectionWave({ animate, beat = false }: { animate: boolean; beat?: boolean }) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = ref.current;
    if (!svg || !animate) return;
    let cancelled = false;
    let ctx: { revert: () => void } | undefined;
    (async () => {
      const gsap = (await import('gsap')).default;
      const { ScrollTrigger } = await import('gsap/ScrollTrigger');
      const { DrawSVGPlugin } = await import('gsap/DrawSVGPlugin');
      if (cancelled) return;
      gsap.registerPlugin(ScrollTrigger, DrawSVGPlugin);
      ctx = gsap.context(() => {
        const tl = gsap.timeline({
          scrollTrigger: { trigger: svg, start: 'top 88%', toggleActions: 'play none none reverse' },
        });
        tl.fromTo('.wave-av', { scale: 0, transformOrigin: '50% 50%' }, { scale: 1, duration: 0.4, ease: 'back.out(2)', stagger: 0.05 })
          .fromTo('.wave-line', { drawSVG: '0%' }, { drawSVG: '100%', duration: 1.3, ease: 'power2.inOut' }, '-=0.2');
      }, svg);
    })().catch(() => {
      // gsap unavailable (tests, blocked script): the static layout stays
    });
    return () => {
      cancelled = true;
      ctx?.revert();
    };
  }, [animate]);

  // the two listeners breathe on the shared beat while the wave is on screen
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !beat || typeof IntersectionObserver === 'undefined') return;
    let raf = 0;
    let on = false;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      box.style.setProperty('--beat', beatAt(Date.now()).pulse.toFixed(3));
    };
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !on) {
        on = true;
        raf = requestAnimationFrame(frame);
      } else if (!e.isIntersecting && on) {
        on = false;
        cancelAnimationFrame(raf);
      }
    });
    io.observe(box);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [beat]);

  return (
    <div ref={boxRef} className="wave-break" data-beat={beat ? '' : undefined} aria-hidden="true">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="xMidYMid meet">
        <path className="wave-line" d={PATH} fill="none" stroke="var(--color-accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <g className="wave-av"><circle cx={X0 - 30} cy={H / 2} r="21" fill="var(--color-ident-1)" /><text x={X0 - 30} y={H / 2 + 5} textAnchor="middle" fontSize="15" fontWeight="700" fill="oklch(0.15 0.01 280)">L</text></g>
        <g className="wave-av"><circle cx={X1 + 30} cy={H / 2} r="21" fill="var(--color-ident-2)" /><text x={X1 + 30} y={H / 2 + 5} textAnchor="middle" fontSize="15" fontWeight="700" fill="oklch(0.15 0.01 280)">M</text></g>
      </svg>
    </div>
  );
}
