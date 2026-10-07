'use client';

// The sintonia ground (#325): two colours taken from the cover on stage (the
// dominant one and its nearest neighbour) drifting under one scrim level.
// Layers stack: a new track pushes a new layer which opens as a clip-path circle
// from the cover (the room's colour wash) or fades in, then the old layer goes.
// `animate` false (prefers-reduced-motion) renders one static frame.
import { useEffect, useRef, useState } from 'react';
import { tintCss, type Tint } from '@/lib/trackColor';

export type GroundSpec = { palette: Tint[] | null };

const specKey = (s: GroundSpec): string | null => (s.palette ? s.palette.map((p) => p.h.toFixed(0)).join(',') : null);

function GroundLayer({ spec, animate }: { spec: GroundSpec; animate: boolean }) {
  const [a, b] = spec.palette ?? [];
  const vars: Record<string, string> | undefined =
    a && b ? { '--s0': tintCss(a), '--s1': tintCss(b), '--sbase': tintCss({ l: Math.max(0.14, a.l - 0.2), c: a.c * 0.6, h: a.h }) } : undefined;
  return (
    <div className={`gl gl--sintonia${animate ? '' : ' is-static'}`} style={vars as React.CSSProperties}>
      <i className="gl-sblob gl-sblob--a" />
      <i className="gl-sblob gl-sblob--b" />
      <span className="gl-scrim" />
    </div>
  );
}

type Layer = { id: number; spec: GroundSpec };

export function GroundStack({
  spec,
  animate,
  originSelector,
  className = '',
}: {
  spec: GroundSpec;
  animate: boolean;
  /** element whose centre the wash opens from (the cover on stage) */
  originSelector?: string;
  className?: string;
}) {
  const [layers, setLayers] = useState<Layer[]>([]);
  const lastKey = useRef<string | null>(null);
  const nextId = useRef(1);
  const els = useRef(new Map<number, HTMLDivElement>());
  const animated = useRef(0);
  const [hold, setHold] = useState(false);

  // callers pass a fresh spec object every render; only its colour key matters
  const specRef = useRef(spec);
  useEffect(() => {
    specRef.current = spec;
  });
  const key = specKey(spec);
  useEffect(() => {
    if (!key || key === lastKey.current) return;
    lastKey.current = key;
    const layer = { id: nextId.current++, spec: specRef.current };
    setLayers((prev) => (prev.length === 0 || !animate ? [layer] : [...prev, layer]));
  }, [key, animate]);

  useEffect(() => {
    if (layers.length < 2) return;
    const top = layers[layers.length - 1];
    if (animated.current === top.id) return;
    animated.current = top.id;
    const el = els.current.get(top.id);
    if (!el) return;
    let cancelled = false;
    let tween: { kill: () => void } | undefined;
    (async () => {
      const gsap = (await import('gsap').catch(() => null))?.default;
      const finish = () => !cancelled && setLayers((prev) => prev.filter((l) => l.id === top.id));
      if (!gsap || cancelled) return finish();
      const origin = originSelector ? document.querySelector<HTMLElement>(originSelector) : null;
      const host = el.parentElement;
      const hr = host?.getBoundingClientRect();
      if (origin && hr) {
        const r = origin.getBoundingClientRect();
        const cx = r.left + r.width / 2 - hr.left;
        const cy = r.top + r.height / 2 - hr.top;
        const reach = Math.hypot(Math.max(cx, hr.width - cx), Math.max(cy, hr.height - cy));
        tween = gsap.fromTo(el, { clipPath: `circle(0px at ${cx}px ${cy}px)` }, { clipPath: `circle(${reach}px at ${cx}px ${cy}px)`, duration: 0.95, ease: 'power2.out', onComplete: finish });
      } else {
        tween = gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.9, ease: 'power1.inOut', onComplete: finish });
      }
    })();
    return () => {
      cancelled = true;
      tween?.kill();
    };
  }, [layers, originSelector]);

  // pause the drifting loops while the tab is hidden or the ground is off-screen
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    let visible = true;
    const sync = () => setHold(!(visible && !document.hidden));
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      sync();
    });
    io.observe(root);
    document.addEventListener('visibilitychange', sync);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  return (
    <div ref={rootRef} className={`ground-stack ${hold ? 'is-held' : ''} ${className}`} data-ground="sintonia" aria-hidden="true">
      {layers.map((l) => (
        <div
          key={l.id}
          ref={(n) => {
            if (n) els.current.set(l.id, n);
            else els.current.delete(l.id);
          }}
          className="ground-stack__layer"
        >
          <GroundLayer spec={l.spec} animate={animate} />
        </div>
      ))}
    </div>
  );
}
