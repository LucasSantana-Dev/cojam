'use client';

// Mark + "CoJam" wordmark treatments (axis wordmark). `text` is the shipped
// markup byte for byte; the lockups pair the same mark with Bricolage in a
// different weight, width, spacing or arrangement. Casing stays "CoJam".
import { LogoMark } from './Logo';
import { useAxis } from '@/lib/brandAxes';

export function Wordmark({ size, animated = false }: { size: number; animated?: boolean }) {
  const kind = useAxis('wordmark');

  if (kind === 'lockup-a') {
    // Tight 800; the J rides a little high, echoing the headband arc.
    return (
      <span className="wordmark wordmark--a">
        <LogoMark size={Math.round(size * 1.3)} animated={animated} />
        <span className="wordmark__text">
          Co<span className="wordmark__j">J</span>am
        </span>
      </span>
    );
  }
  if (kind === 'lockup-b') {
    // Medium weight, wide tracking, hairline divider between mark and name.
    return (
      <span className="wordmark wordmark--b">
        <LogoMark size={size} animated={animated} />
        <span className="wordmark__rule" aria-hidden />
        <span className="wordmark__text">CoJam</span>
      </span>
    );
  }
  if (kind === 'lockup-c') {
    // Stacked: mark over name, centered.
    return (
      <span className="wordmark wordmark--c">
        <LogoMark size={Math.round(size * 1.35)} animated={animated} />
        <span className="wordmark__text">CoJam</span>
      </span>
    );
  }
  return (
    <>
      <LogoMark size={size} animated={animated} /> CoJam
    </>
  );
}
