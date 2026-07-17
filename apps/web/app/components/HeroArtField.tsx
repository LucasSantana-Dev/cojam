'use client';

import { useEffect, useRef } from 'react';

// Floating album art behind the hero: four real covers as tilted planes that
// drift slowly and parallax-tilt toward the cursor. Pure DOM + CSS 3D (no
// WebGL): replaces the old R3F icosahedron and its three.js bundle cost.
// Decorative: aria-hidden, empty alt, dimmed under the headline.
const COVERS = [
  {
    src: 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/e8/43/5f/e8435ffa-b6b9-b171-40ab-4ff3959ab661/886443919266.jpg/600x600bb.jpg',
    className: 'hero-art hero-art-a',
  },
  {
    src: 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/a6/6e/bf/a66ebf79-5008-8948-b352-a790fc87446b/19UM1IM04638.rgb.jpg/600x600bb.jpg',
    className: 'hero-art hero-art-b',
  },
  {
    src: 'https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/6c/11/d6/6c11d681-aa3a-d59e-4c2e-f77e181026ab/190295092665.jpg/600x600bb.jpg',
    className: 'hero-art hero-art-c',
  },
  {
    src: 'https://is1-ssl.mzstatic.com/image/thumb/Music122/v4/b0/9c/b7/b09cb72c-cca9-5d66-bc9d-a9b5e5f86b22/5054197236389.jpg/600x600bb.jpg',
    className: 'hero-art hero-art-d',
  },
];

export function HeroArtField() {
  const fieldRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    // Lerp the cursor offset into CSS vars; each cover multiplies it by its
    // own depth factor in CSS. Momentum, not snap.
    let tx = 0, ty = 0, cx = 0, cy = 0;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      const r = field.getBoundingClientRect();
      tx = (e.clientX - (r.left + r.width / 2)) / r.width; // -0.5..0.5
      ty = (e.clientY - (r.top + r.height / 2)) / r.height;
    };
    const tick = () => {
      cx += (tx - cx) * 0.06;
      cy += (ty - cy) * 0.06;
      field.style.setProperty('--tilt-x', cx.toFixed(4));
      field.style.setProperty('--tilt-y', cy.toFixed(4));
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={fieldRef} className="hero-art-field" aria-hidden>
      {COVERS.map((c) => (
        <img
          key={c.src}
          src={c.src}
          alt=""
          className={c.className}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
        />
      ))}
    </div>
  );
}
