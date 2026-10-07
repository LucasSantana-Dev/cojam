'use client';

// The one connection element of the "sintonia" ground (#325): the logo's sine
// wave as a single thin line that links the listener avatar row, inside the
// stage (room) or inside the phone mock (landing). It breathes on the shared
// beat clock (lib/beatClock, 100 bpm, aligned by the synced room clock) while
// playing, and lies flat when paused or when motion is off. Avatars get at most
// a tiny pulse. White only: the cover palette is the ground's, violet is for
// actions, green is LIVE. No audio analysis.
import { useEffect, useRef } from 'react';
import { beatAt } from '@/lib/beatClock';
import { avatarGradient } from '@/lib/avatar';

export type WaveMember = { id: string; name: string };

const MAX = 5;

export function ListenersWave({
  members,
  running,
  animate,
  getOffsetMs,
  label,
  className = '',
}: {
  members: WaveMember[];
  running: boolean;
  animate: boolean;
  getOffsetMs?: () => number;
  label?: string;
  className?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const live = useRef({ running, animate, getOffsetMs });
  useEffect(() => {
    live.current = { running, animate, getOffsetMs };
  });
  const shown = members.slice(0, MAX);
  const count = shown.length;

  useEffect(() => {
    const box = boxRef.current;
    const path = pathRef.current;
    if (!box || !path || typeof IntersectionObserver === 'undefined' || typeof ResizeObserver === 'undefined') return;
    let centres: Array<{ x: number; y: number; el: HTMLElement }> = [];
    let raf = 0;
    let on = false;
    let visible = true;

    const measure = () => {
      const b = box.getBoundingClientRect();
      centres = Array.from(box.querySelectorAll<HTMLElement>('.lw-av')).map((el) => {
        const r = el.getBoundingClientRect();
        return { el, x: r.left + r.width / 2 - b.left, y: r.top + r.height / 2 - b.top };
      });
    };
    const draw = () => {
      const { running: run, animate: anim, getOffsetMs: off } = live.current;
      const t = Date.now() + (off?.() ?? 0);
      const breathing = run && anim;
      const { pulse } = beatAt(t);
      const amp = breathing ? 4 + 9 * pulse : 0; // flat when paused
      const ph = breathing ? ((t % 2400) / 2400) * Math.PI * 2 : 0;
      let d = '';
      for (let i = 0; i < centres.length - 1; i++) {
        const a = centres[i];
        const c = centres[i + 1];
        const x0 = a.x + 17;
        const x1 = c.x - 17;
        const len = x1 - x0;
        if (len < 20) continue;
        const steps = Math.max(10, Math.round(len / 4));
        for (let s = 0; s <= steps; s++) {
          const u = s / steps;
          const env = Math.sin(Math.PI * u) ** 0.8; // flat where it meets each avatar
          const y = a.y + (c.y - a.y) * u + Math.sin(u * (len / 38) * Math.PI * 2 - ph) * amp * env;
          d += `${s === 0 ? 'M' : 'L'}${(x0 + len * u).toFixed(1)} ${y.toFixed(1)}`;
        }
      }
      path.setAttribute('d', d);
      path.style.opacity = breathing ? (0.5 + 0.35 * pulse).toFixed(3) : '0.45';
      for (const q of centres) q.el.style.setProperty('--beat', breathing ? pulse.toFixed(3) : '0');
    };
    const frame = () => {
      raf = requestAnimationFrame(frame);
      draw();
    };
    const sync = () => {
      const should = live.current.animate && live.current.running && visible && !document.hidden;
      if (should && !on) {
        on = true;
        raf = requestAnimationFrame(frame);
      } else if (!should && on) {
        on = false;
        cancelAnimationFrame(raf);
        draw();
      }
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      sync();
    });
    io.observe(box);
    const ro = new ResizeObserver(() => {
      measure();
      draw();
    });
    ro.observe(box);
    document.addEventListener('visibilitychange', sync);
    measure();
    draw();
    sync();
    const poll = window.setInterval(() => {
      sync();
      if (!on) draw();
    }, 400);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [count]);

  return (
    <div ref={boxRef} className={`listeners-wave ${className}`} role="group" aria-label={label ?? 'Quem está ouvindo'}>
      <svg className="listeners-wave__svg" aria-hidden="true">
        <path ref={pathRef} fill="none" stroke="oklch(1 0 0)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {shown.map((m) => (
        <span key={m.id} className="lw-av" title={m.name} style={{ background: avatarGradient(m.id || m.name) }}>
          {m.name.charAt(0).toUpperCase()}
        </span>
      ))}
    </div>
  );
}
