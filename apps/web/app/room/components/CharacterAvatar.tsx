'use client';

// A member's portrait inside an avatar circle, or the initial when the image
// does not load. The circle (gradient, border, badge) belongs to the parent;
// this only fills it. The art is 64x64 and is never smoothed: `px-portrait`
// sets image-rendering: pixelated and the parents size the circle to 64px
// (1x) or 32px (a clean 1:2 step), never a fractional scale.
import { useState } from 'react';
import { portraitSrc } from '@/lib/characters';

interface CharacterAvatarProps {
  characterId: number;
  initial: string;
  // 32px (half step) instead of 64px, for chat and the top bar.
  half?: boolean;
}

export function CharacterAvatar({ characterId, initial, half = false }: CharacterAvatarProps) {
  const [failed, setFailed] = useState<number | null>(null);
  if (failed === characterId) return <span aria-hidden="true">{initial}</span>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- pixel art must reach the browser untouched (no optimizer resampling)
    <img
      className={`px-portrait${half ? ' px-portrait--half' : ''}`}
      src={portraitSrc(characterId)}
      alt=""
      width={64}
      height={64}
      draggable={false}
      onError={() => setFailed(characterId)}
    />
  );
}
