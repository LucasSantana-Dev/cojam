'use client';

// CoJam mark "N3" (supersedes "Two Listeners", ADR-0004). Two-color: the headphone
// FRAME is the violet identity sweep; the CORE (disc with the wave knocked out) is
// the music-green accent.
// `animated` makes both gradients flow slowly (colors moving = in sync); it is
// SSR-safe (renders static first) and disabled under prefers-reduced-motion.
import { useId, useSyncExternalStore } from 'react';

import { MARK_FRAME, MARK_DISC, MARK_VIEWBOX, FRAME_GRADIENT, CORE_GRADIENT } from './logoMark';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void) {
  const mq = window.matchMedia(REDUCED_MOTION_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
const getReducedMotion = () => window.matchMedia(REDUCED_MOTION_QUERY).matches;
// Server + first client render assume reduced motion, so SSR always ships
// the static gradients; flow is enabled after hydration when motion is
// allowed (a false snapshot would SSR the SMIL animations, which also run
// for reduced-motion users pre-hydration and with JS disabled).
const getReducedMotionServer = () => true;


export function LogoMark({
  size = 16,
  glow = false,
  animated = false,
}: {
  size?: number;
  glow?: boolean;
  animated?: boolean;
}) {
  const raw = useId().replace(/:/g, '');
  const frame = `cjF-${raw}`;
  const core = `cjC-${raw}`;

  // Static on the server + first client render (server snapshot is true =
  // reduced); flow is enabled only when requested and motion is allowed.
  const reduceMotion = useSyncExternalStore(subscribeReducedMotion, getReducedMotion, getReducedMotionServer);
  const flow = animated && !reduceMotion;

  return (
    <svg
      width={size}
      height={size}
      viewBox={MARK_VIEWBOX}
      fill="none"
      aria-hidden
      focusable="false"
      style={glow ? { filter: 'drop-shadow(0 0 14px color-mix(in oklab, var(--color-ident-1) 45%, transparent))' } : undefined}
    >
      <defs>
        {flow ? (
          <>
            <linearGradient id={frame} x1={FRAME_GRADIENT.x1} y1={FRAME_GRADIENT.y} x2={FRAME_GRADIENT.x1 + 116} y2={FRAME_GRADIENT.y} gradientUnits="userSpaceOnUse" spreadMethod="repeat">
              <stop offset="0" stopColor="var(--logo-frame-from, oklch(0.587 0.232 281.2))" />
              <stop offset="0.5" stopColor="var(--logo-frame-to, oklch(0.681 0.233 311.2))" />
              <stop offset="1" stopColor="var(--logo-frame-from, oklch(0.587 0.232 281.2))" />
              <animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="116 0" dur="9s" repeatCount="indefinite" />
            </linearGradient>
            <linearGradient id={core} x1={CORE_GRADIENT.x} y1={CORE_GRADIENT.y1 + 6} x2={CORE_GRADIENT.x} y2={CORE_GRADIENT.y1 + 6 + 87} gradientUnits="userSpaceOnUse" spreadMethod="repeat">
              <stop offset="0" stopColor="var(--logo-core-from, oklch(0.849 0.207 128.8))" />
              <stop offset="0.5" stopColor="var(--logo-core-to, oklch(0.696 0.149 162.5))" />
              <stop offset="1" stopColor="var(--logo-core-from, oklch(0.849 0.207 128.8))" />
              <animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="0 87" dur="7s" repeatCount="indefinite" />
            </linearGradient>
          </>
        ) : (
          <>
            <linearGradient id={frame} x1={FRAME_GRADIENT.x1} y1={FRAME_GRADIENT.y} x2={FRAME_GRADIENT.x2} y2={FRAME_GRADIENT.y} gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="var(--logo-frame-from, oklch(0.587 0.232 281.2))" />
              <stop offset="1" stopColor="var(--logo-frame-to, oklch(0.681 0.233 311.2))" />
            </linearGradient>
            <linearGradient id={core} x1={CORE_GRADIENT.x} y1={CORE_GRADIENT.y1} x2={CORE_GRADIENT.x} y2={CORE_GRADIENT.y2} gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="var(--logo-core-from, oklch(0.849 0.207 128.8))" />
              <stop offset="1" stopColor="var(--logo-core-to, oklch(0.696 0.149 162.5))" />
            </linearGradient>
          </>
        )}
      </defs>
      <path d={MARK_FRAME} fill={`url(#${frame})`} />
      <path d={MARK_DISC} fill={`url(#${core})`} fillRule="evenodd" />
    </svg>
  );
}
