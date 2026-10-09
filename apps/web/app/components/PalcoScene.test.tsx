import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PalcoScene } from './PalcoScene';
import { PalcoErrorView } from './PalcoErrorView';
import { CHARACTER_NAMES } from '@/lib/characters';
import { SCENES } from '@/lib/palcoScenes.generated';

describe('PalcoScene', () => {
  it('renders decorative pixel art and no baked-in labels', () => {
    const { container } = render(<PalcoScene kind="home" />);
    const imgs = container.querySelectorAll('img');
    expect(imgs.length).toBe(2);
    imgs.forEach((i) => expect(i.getAttribute('alt')).toBe(''));
    expect(container.querySelector('.pws__art')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('tags the home crowd with roster names from lib/characters', () => {
    const { container } = render(<PalcoScene kind="home" />);
    const wide = container.querySelector('.pws__v--wide')!;
    const tags = Array.from(wide.querySelectorAll('.pws-tag')).map((t) => t.textContent);
    const roster = SCENES['home-wide'].sprites.map((s) => CHARACTER_NAMES[s.id - 1]);
    expect(tags).toEqual(expect.arrayContaining(roster));
    expect(tags).toContain('Prévia da sala');
  });

  it('puts only you and the bubble on the 404 floor', () => {
    render(<PalcoScene kind="404" />);
    expect(screen.getAllByText('Você').length).toBe(2);
    expect(screen.getAllByText('cadê todo mundo?').length).toBe(2);
  });

  it('shows no overlays on the erro scene', () => {
    const { container } = render(<PalcoScene kind="erro" />);
    expect(container.querySelectorAll('.pws-at').length).toBe(0);
  });

  it('uses the measured integer scale after mount', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
    const { container } = render(<PalcoScene kind="404" />);
    expect(container.querySelector('.pws')?.getAttribute('style')).toContain('--kw: 3');
    expect(container.querySelector('.pws')?.getAttribute('style')).toContain('--kp: 7');
  });
});

describe('PalcoErrorView', () => {
  it('shows the erro copy, no codes, and calls reset', () => {
    const reset = vi.fn();
    const { container } = render(
      <PalcoErrorView brand={<span>CoJam</span>} home={<span>Voltar ao início</span>} reset={reset} />,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('A plateia está esperando');
    expect(container.textContent).toContain('A sala e a fila estão guardadas no servidor.');
    expect(container.textContent).not.toMatch(/ref |digest/i);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
