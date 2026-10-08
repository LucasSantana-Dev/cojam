'use client';

// "Escolha quem vai pra plateia": the 12-portrait roster as a radio group.
// Roving tabindex, arrow keys move and select (radio semantics), 44px+ targets,
// the selected one shows a violet ring plus a check (never colour alone).
// Repeats are allowed, so nothing is ever disabled.
import { useRef, useState } from 'react';
import { CHARACTER_COUNT, CHARACTER_LABELS, portraitSrc } from '@/lib/characters';
import { CheckIcon } from '@/app/components/icons';

interface CharacterPickerProps {
  value: number;
  onChange: (id: number) => void;
  // Element ids, unique per instance (the picker appears on two screens).
  idPrefix: string;
  // Heading level for the title, so each screen keeps a valid outline.
  as?: 'h2' | 'h3' | 'p';
}

const IDS = Array.from({ length: CHARACTER_COUNT }, (_, i) => i + 1);

export function CharacterPicker({ value, onChange, idPrefix, as: Title = 'p' }: CharacterPickerProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const [failed, setFailed] = useState<Record<number, true>>({});

  const move = (from: number, delta: number) => {
    const next = ((from - 1 + delta + CHARACTER_COUNT) % CHARACTER_COUNT) + 1;
    onChange(next);
    refs.current[next - 1]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent, id: number) => {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        move(id, 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        move(id, -1);
        break;
      case 'Home':
        e.preventDefault();
        move(CHARACTER_COUNT, 1);
        break;
      case 'End':
        e.preventDefault();
        move(1, -1);
        break;
    }
  };

  return (
    <div className="r4-chars">
      <Title className="r4-join__label r4-chars__title" id={`${idPrefix}-title`}>
        Escolha quem vai pra plateia
      </Title>
      <p className="r4-chars__hint" id={`${idPrefix}-hint`}>
        Pode repetir: outras pessoas podem escolher o mesmo
      </p>
      <div className="r4-chars__grid" role="radiogroup" aria-labelledby={`${idPrefix}-title`} aria-describedby={`${idPrefix}-hint`}>
        {IDS.map((id) => {
          const selected = id === value;
          return (
            <button
              key={id}
              ref={(el) => {
                refs.current[id - 1] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`Personagem ${id}: ${CHARACTER_LABELS[id - 1]}`}
              tabIndex={selected ? 0 : -1}
              className="r4-chars__btn"
              onClick={() => onChange(id)}
              onKeyDown={(e) => onKeyDown(e, id)}
            >
              {failed[id] ? (
                <span className="r4-chars__fallback" aria-hidden="true">{id}</span>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- pixel art must reach the browser untouched
                <img
                  className="px-portrait"
                  src={portraitSrc(id)}
                  alt=""
                  width={64}
                  height={64}
                  draggable={false}
                  onError={() => setFailed((f) => ({ ...f, [id]: true }))}
                />
              )}
              {selected && (
                <span className="r4-chars__check" aria-hidden="true">
                  <CheckIcon size={14} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
