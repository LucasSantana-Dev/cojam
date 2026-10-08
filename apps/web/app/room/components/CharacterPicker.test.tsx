import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { CharacterPicker } from './CharacterPicker';
import { CharacterAvatar } from './CharacterAvatar';

function Harness({ start = 1, onChange = () => {} }: { start?: number; onChange?: (id: number) => void }) {
  const [v, setV] = useState(start);
  return (
    <CharacterPicker
      idPrefix="t"
      value={v}
      onChange={(id) => {
        setV(id);
        onChange(id);
      }}
    />
  );
}

const radios = () => screen.getAllByRole('radio');

describe('CharacterPicker', () => {
  it('shows the title, the hint and 13 radios in one group', () => {
    render(<Harness />);
    expect(screen.getByText('Escolha quem vai pra plateia')).toBeInTheDocument();
    expect(screen.getByText('Pode repetir: outras pessoas podem escolher o mesmo')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Escolha quem vai pra plateia' })).toBeInTheDocument();
    expect(radios()).toHaveLength(13);
    for (const r of radios()) expect(r.tagName).toBe('BUTTON');
  });

  it('marks only the selected radio, with a check, and gives it the tab stop', () => {
    render(<Harness start={5} />);
    const rs = radios();
    expect(rs.filter((r) => r.getAttribute('aria-checked') === 'true')).toEqual([rs[4]]);
    expect(rs[4].querySelector('.r4-chars__check')).not.toBeNull();
    expect(rs.filter((r) => r.querySelector('.r4-chars__check'))).toHaveLength(1);
    expect(rs.filter((r) => r.tabIndex === 0)).toEqual([rs[4]]);
  });

  it('selects on click, including a repeat of the same character', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(radios()[8]);
    expect(onChange).toHaveBeenLastCalledWith(9);
    expect(radios()[8]).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(radios()[8]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('moves and selects with the arrow keys, wrapping at both ends', () => {
    const onChange = vi.fn();
    render(<Harness start={1} onChange={onChange} />);
    radios()[0].focus();
    fireEvent.keyDown(radios()[0], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(2);
    expect(radios()[1]).toHaveFocus();
    fireEvent.keyDown(radios()[1], { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith(3);
    fireEvent.keyDown(radios()[2], { key: 'ArrowLeft' });
    fireEvent.keyDown(radios()[1], { key: 'ArrowUp' });
    expect(radios()[0]).toHaveFocus();
    fireEvent.keyDown(radios()[0], { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(13);
    expect(radios()[12]).toHaveFocus();
    fireEvent.keyDown(radios()[12], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(radios()[0], { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(13);
    fireEvent.keyDown(radios()[12], { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('shows the name and gives "<Nome>, <descrição>" as the accessible name, Mel included', () => {
    render(<Harness />);
    expect(radios()[2]).toHaveTextContent('Seu Zé');
    expect(radios()[2]).toHaveAccessibleName('Seu Zé, Homem calvo de óculos e camisa florida');
    expect(radios()[12]).toHaveAccessibleName('Mel, Cachos pretos volumosos e blusa vinho');
    expect(radios()[12]).toHaveTextContent('Mel');
  });

  it('ignores other keys', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(radios()[0], { key: 'a' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('draws pixel portraits and falls back to the number when one fails', () => {
    render(<Harness />);
    const imgs = document.querySelectorAll('img.px-portrait');
    expect(imgs).toHaveLength(13);
    expect(imgs[2]).toHaveAttribute('src', '/palco/characters/03-portrait.png');
    fireEvent.error(imgs[2]);
    expect(document.querySelectorAll('img.px-portrait')).toHaveLength(12);
    expect(radios()[2]).toHaveTextContent('3');
  });
});

describe('CharacterAvatar', () => {
  it('shows the portrait, and the initial when the image fails', () => {
    const { container } = render(<CharacterAvatar characterId={4} initial="B" />);
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('src', '/palco/characters/04-portrait.png');
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('B');
  });

  it('retries a different character after a failure', () => {
    const { container, rerender } = render(<CharacterAvatar characterId={4} initial="B" />);
    fireEvent.error(container.querySelector('img')!);
    rerender(<CharacterAvatar characterId={5} initial="B" />);
    expect(container.querySelector('img')).toHaveAttribute('src', '/palco/characters/05-portrait.png');
  });

  it('uses the half step class for 32px slots', () => {
    const { container } = render(<CharacterAvatar characterId={1} initial="B" half />);
    expect(container.querySelector('img')).toHaveClass('px-portrait--half');
  });
});
