'use client';

// "Como funciona em 3 passos" as a pinned scroll story (#325, motion moment 2).
// One ScrollTrigger pin + scrub holds the phone while the page scrolls through
// the three steps: each step puts the next track on the phone and washes the
// stage to that track's colour. Snaps to steps. The only pinned section on the
// page. Mounted only when motion is on (never under prefers-reduced-motion).
import { useEffect, useRef, useState } from 'react';
import { HeroDevice } from './HeroDevice';
import { DEMO_TRACKS, demoTintStyle } from '@/lib/demoTracks';

type Step = { n: string; t: string; d: string };

export function ScrollStory({
  steps,
  waveAnimate = false,
  onActive,
}: {
  steps: readonly Step[];
  waveAnimate?: boolean;
  /** step index while the story is pinned, null when it is not (drives the page ground) */
  onActive?: (step: number | null) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const activeRef = useRef(0);
  const onActiveRef = useRef(onActive);
  useEffect(() => {
    onActiveRef.current = onActive;
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let cancelled = false;
    let ctx: { revert: () => void } | undefined;
    (async () => {
      const gsap = (await import('gsap')).default;
      const { ScrollTrigger } = await import('gsap/ScrollTrigger');
      if (cancelled) return;
      gsap.registerPlugin(ScrollTrigger);
      const last = steps.length - 1;
      ctx = gsap.context(() => {
        ScrollTrigger.create({
          trigger: root,
          start: 'top 72px',
          end: '+=190%',
          pin: true,
          scrub: true,
          anticipatePin: 1,
          snap: { snapTo: 1 / last, duration: { min: 0.15, max: 0.5 }, ease: 'power1.inOut' },
          onToggle: (self) => onActiveRef.current?.(self.isActive ? activeRef.current : null),
          onUpdate: (self) => {
            const idx = Math.round(self.progress * last);
            if (idx === activeRef.current) return;
            activeRef.current = idx;
            setActive(idx);
            onActiveRef.current?.(idx);
            // the room on the phone scrolls to the next track
            gsap.fromTo(
              root.querySelectorAll('.dev-stage, .dev-chat'),
              { yPercent: idx > 0 ? 12 : -12, opacity: 0 },
              { yPercent: 0, opacity: 1, duration: 0.5, ease: 'power3.out', stagger: 0.06, overwrite: true },
            );
          },
        });
      }, root);
    })().catch(() => {
      // gsap unavailable (tests, blocked script): the static layout stays
    });
    return () => {
      cancelled = true;
      onActiveRef.current?.(null);
      ctx?.revert();
    };
  }, [steps]);

  return (
    <div ref={rootRef} className="story" data-tint="story" data-step={active} style={demoTintStyle(active)}>
      <ol className="story__steps">
        {steps.map((s, i) => (
          <li key={s.n} className="story__step" aria-current={i === active ? 'step' : undefined} data-active={i === active}>
            <span className="step-num">{s.n}]</span>
            <h3>{s.t}</h3>
            <p>{s.d}</p>
          </li>
        ))}
      </ol>
      <div className="story__phone">
        <HeroDevice index={active % DEMO_TRACKS.length} waveAnimate={waveAnimate} />
      </div>
    </div>
  );
}
