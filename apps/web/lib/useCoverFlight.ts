import { useEffect, useRef } from 'react';

/**
 * Motion moment 4a (#325): when the now-playing track changes, the new cover flies
 * from its queue row to the stage. A FLIP done by hand with gsap (first = the row
 * thumb, last = the cover, transform from first to identity), so gsap/Flip stays
 * out of the bundle. Skipped on first load, when either end is not on screen
 * (phone tabs hide the queue) or when `enabled` is false.
 */
export function useCoverFlight(trackId: string | undefined, enabled: boolean) {
  const prev = useRef<string | undefined>(undefined);
  useEffect(() => {
    const before = prev.current;
    prev.current = trackId;
    if (!enabled || !trackId || !before || before === trackId) return;
    let cancelled = false;
    let tween: { kill: () => void } | undefined;
    let flying: HTMLElement | undefined;
    const raf = requestAnimationFrame(async () => {
      const cover = document.querySelector<HTMLElement>('.r4-cover');
      const row = document.querySelector<HTMLElement>(`[data-track-id="${CSS.escape(trackId)}"] .fq-art`);
      if (!cover || !row) return;
      const first = row.getBoundingClientRect();
      const last = cover.getBoundingClientRect();
      if (first.width === 0 || last.width === 0) return;
      const gsap = (await import('gsap').catch(() => null))?.default;
      if (!gsap || cancelled) return;
      flying = cover;
      cover.classList.add('is-flying');
      tween = gsap.fromTo(
        cover,
        { x: first.left - last.left, y: first.top - last.top, scale: first.width / last.width, transformOrigin: '0 0' },
        {
          x: 0,
          y: 0,
          scale: 1,
          duration: 0.85,
          ease: 'power3.inOut',
          onComplete: () => {
            cover.classList.remove('is-flying');
            gsap.set(cover, { clearProps: 'transform,transformOrigin' });
          },
        },
      );
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (tween && flying) {
        tween.kill();
        flying.classList.remove('is-flying');
        flying.style.removeProperty('transform');
        flying.style.removeProperty('transform-origin');
      }
    };
  }, [trackId, enabled]);
}
