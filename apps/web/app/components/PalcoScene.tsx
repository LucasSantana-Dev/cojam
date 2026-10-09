'use client';

import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { CHARACTER_NAMES } from '@/lib/characters';
import { pickScale } from '@/lib/palcoScale';
import { SCENES, type SceneArt, type SceneName } from '@/lib/palcoScenes.generated';
import { PALCO_PAGE_CSS } from './palcoCss';

// The shared page shell for the palco screens (home, 404, erro). Two layers, never
// mixed: the scene art at an INTEGER scale (nearest neighbour), and DOM overlays
// (name tags, bubble, labels) placed in native coordinates times k, so they stay
// locked to the art at every width. The art is decorative (alt=""): the page text
// carries the meaning.
//
// k is pickScale(native width, available width). CSS media queries give the first
// paint a close guess (--kw, --kp in palcoCss); once mounted the measured value
// replaces it.

export type SceneKind = 'home' | '404' | 'erro';

const NATIVE_W = { wide: 480, phone: 195 } as const;

type Variant = 'wide' | 'phone';

function rosterName(id: number): string {
  return CHARACTER_NAMES[id - 1] ?? '';
}

function vars(o: Record<string, string | number>): CSSProperties {
  return o as CSSProperties;
}

function Overlays({ kind, variant, art }: { kind: SceneKind; variant: Variant; art: SceneArt }) {
  if (kind === 'home') {
    const { screen } = art;
    return (
      <>
        {art.sprites.map((s) => (
          <span key={`${s.id}-${s.cx}`} className="pws-at pws-at--up" style={vars({ '--x': s.cx, '--y': s.top })}>
            <span className="pws-tag">{rosterName(s.id)}</span>
          </span>
        ))}
        {variant === 'wide' ? (
          <span className="pws-at pws-at--below" style={vars({ '--x': screen.x, '--y': screen.y + screen.h })}>
            <span className="pws-tag">Prévia da sala</span>
          </span>
        ) : (
          <span className="pws-at pws-at--upleft" style={vars({ '--x': screen.x, '--y': screen.y })}>
            <span className="pws-tag">Prévia da sala</span>
          </span>
        )}
      </>
    );
  }
  if (kind === '404') {
    const me = art.sprites[0];
    if (!me) return null;
    return (
      <span className="pws-at pws-at--up" style={vars({ '--x': me.cx, '--y': me.top })}>
        <span className="pws-stack">
          <span className="pws-bubble">cadê todo mundo?</span>
          <span className="pws-tag pws-tag--you">Você</span>
        </span>
      </span>
    );
  }
  return null;
}

export function PalcoScene({
  kind,
  hero = false,
  testId,
  id,
  children,
}: {
  kind: SceneKind;
  /** Home only: from 80rem the art sits behind the children instead of above them. */
  hero?: boolean;
  testId?: string;
  id?: string;
  children?: ReactNode;
}) {
  const [k, setK] = useState<{ wide: number; phone: number } | null>(null);

  // The scene is full-bleed, so the space it can use is the viewport width. Not the
  // element width: a classic scrollbar appearing when the scene grows would shrink
  // that, drop k, shorten the page, remove the scrollbar and flip k back, forever.
  // The few scrollbar pixels that spill are clipped by .pw (overflow-x: clip).
  useEffect(() => {
    const measure = () => {
      const w = window.innerWidth;
      setK((prev) => {
        const next = { wide: pickScale(NATIVE_W.wide, w), phone: pickScale(NATIVE_W.phone, w) };
        return prev && prev.wide === next.wide && prev.phone === next.phone ? prev : next;
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const rootStyle: CSSProperties | undefined = k ? vars({ '--kw': k.wide, '--kp': k.phone }) : undefined;

  return (
    <div className={`pws pws--${kind}${hero ? ' pws--hero' : ''}`} style={rootStyle}>
      <style>{PALCO_PAGE_CSS}</style>
      <div className="pws__art" id={id} data-testid={testId} aria-hidden="true">
        {(['wide', 'phone'] as const).map((variant) => {
          const art = SCENES[`${kind}-${variant}` as SceneName];
          return (
            <div key={variant} className={`pws__v pws__v--${variant}`} style={vars({ '--nw': art.w, '--nh': art.h })}>
              {/* eslint-disable-next-line @next/next/no-img-element -- native pixel art, scaled by whole numbers; next/image would resample it */}
              <img className="pws__img" src={art.src} alt="" width={art.w} height={art.h} loading="lazy" decoding="async" />
              <Overlays kind={kind} variant={variant} art={art} />
            </div>
          );
        })}
      </div>
      {children}
    </div>
  );
}
