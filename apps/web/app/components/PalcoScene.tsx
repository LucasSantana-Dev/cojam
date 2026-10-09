'use client';

import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { CHARACTER_COUNT, CHARACTER_NAMES } from '@/lib/characters';
import { ledLayout, ledPath, type LedLine, type LedSpec } from '@/lib/palcoLed';
import { youTagLabel } from '@/lib/palcoYouTag';
import { pickScale } from '@/lib/palcoScale';
import { SCENES, SPRITE_FRONT, type SceneArt, type SceneName } from '@/lib/palcoScenes.generated';
import { PALCO_PAGE_CSS } from './palcoCss';

// The shared page shell for the palco screens (home, 404, erro, and wave 2: band, band-text,
// join, callback). Two layers, never
// mixed: the scene art at an INTEGER scale (nearest neighbour), and DOM overlays
// (name tags, bubble, labels) placed in native coordinates times k, so they stay
// locked to the art at every width. The art is decorative (alt=""): the page text
// carries the meaning.
//
// k is pickScale(native width, available width). CSS media queries give the first
// paint a close guess (--kw, --kp in palcoCss); once mounted the measured value
// replaces it.

export type SceneKind = 'home' | '404' | 'erro' | 'band' | 'band-text' | 'join' | 'callback';

/** The person on the join floor: the picked roster character (live) and the nickname typed in the form (the tag reads "Você · name"). */
export interface SceneYou {
  id: number;
  name: string;
}

const NATIVE_W = { wide: 480, phone: 195 } as const;

type Variant = 'wide' | 'phone';

function rosterName(id: number): string {
  return CHARACTER_NAMES[id - 1] ?? '';
}

function vars(o: Record<string, string | number>): CSSProperties {
  return o as CSSProperties;
}

function Led({ art, spec }: { art: SceneArt; spec: LedSpec }) {
  const { screen } = art;
  const layout = ledLayout(screen.w, screen.h, spec);
  const lines: Array<[LedLine, string]> = [[layout.title, 'pws-led__t']];
  if (layout.sub) lines.push([layout.sub, `pws-led__s pws-led__s--${layout.subTone}`]);
  return (
    <svg
      className="pws-led"
      data-led={[layout.title.text, layout.sub?.text].filter(Boolean).join(' / ')}
      viewBox={`0 0 ${screen.w} ${screen.h}`}
      style={vars({ '--x': screen.x, '--y': screen.y, '--w': screen.w, '--h': screen.h })}
      aria-hidden="true"
    >
      {lines.map(([line, cls]) => (
        <path key={cls} className={cls} d={ledPath(line)} />
      ))}
    </svg>
  );
}

function Overlays({
  kind,
  variant,
  art,
  led,
  you,
}: {
  kind: SceneKind;
  variant: Variant;
  art: SceneArt;
  led?: LedSpec;
  you?: SceneYou;
}) {
  if (kind === 'join') {
    const { stand } = art;
    return (
      <>
        {led && <Led art={art} spec={led} />}
        {you && stand && (
          <span className="pws-at pws-at--feet" style={vars({ '--x': stand.cx, '--y': stand.feet })}>
            <span className="pws-stack" data-testid="join-you">
              <span className="pws-tag pws-tag--you">{youTagLabel(you.name)}</span>
              {/* eslint-disable-next-line @next/next/no-img-element -- native pixel art, whole-number scale only */}
              <img
                className="pws-sprite"
                src={`/palco/characters/${String(you.id).padStart(2, '0')}-front.png`}
                alt=""
                width={SPRITE_FRONT.w}
                height={SPRITE_FRONT.h}
                draggable={false}
                data-character={you.id}
              />
            </span>
          </span>
        )}
      </>
    );
  }
  if (kind === 'band' || kind === 'band-text' || kind === 'callback') {
    return led ? <Led art={art} spec={led} /> : null;
  }
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
  led,
  you,
  children,
}: {
  kind: SceneKind;
  /** Wave 2: text on the stage screen, drawn in the DOM on the LED font (the page name, the room code). */
  led?: LedSpec;
  /** Join: the picked character stands on the floor; changing it swaps the sprite. */
  you?: SceneYou;
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

  // Every front sprite is a few hundred bytes: fetch them all once, so a new pick
  // swaps without a blank frame.
  const hasYou = Boolean(you);
  useEffect(() => {
    if (!hasYou) return;
    for (let i = 1; i <= CHARACTER_COUNT; i++) {
      new window.Image().src = `/palco/characters/${String(i).padStart(2, '0')}-front.png`;
    }
  }, [hasYou]);

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
              <Overlays kind={kind} variant={variant} art={art} led={led} you={you} />
            </div>
          );
        })}
      </div>
      {children}
    </div>
  );
}
