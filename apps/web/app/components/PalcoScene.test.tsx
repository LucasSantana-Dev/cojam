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

describe('PalcoScene wave 2', () => {
  it.each(['band', 'band-text', 'join', 'callback'] as const)('%s ships blank-screen art for both widths', (kind) => {
    const { container } = render(<PalcoScene kind={kind} />);
    expect(container.querySelectorAll('img').length).toBe(2);
    expect(SCENES[`${kind}-wide`].src).toBe(`/palco/scenes/${kind}-wide.png`);
    expect(SCENES[`${kind}-phone`].src).toBe(`/palco/scenes/${kind}-phone.png`);
  });

  it('draws the LED text in the DOM on both widths, at the screen box of the art', () => {
    const { container } = render(<PalcoScene kind="band" led={{ title: 'AO VIVO', scale: 2, sub: 'SALAS ABERTAS' }} />);
    const leds = container.querySelectorAll('svg.pws-led');
    expect(leds.length).toBe(2);
    leds.forEach((l) => {
      expect(l.getAttribute('data-led')).toBe('AO VIVO / SALAS ABERTAS');
      expect(l.getAttribute('aria-hidden')).toBe('true');
    });
    expect(leds[0].getAttribute('viewBox')).toBe(`0 0 ${SCENES['band-wide'].screen.w} ${SCENES['band-wide'].screen.h}`);
  });

  it('stands the picked character at the join spot of each scene', () => {
    const { container } = render(<PalcoScene kind="join" you={{ id: 14, name: 'Nico' }} />);
    const wide = container.querySelector('.pws__v--wide')!;
    expect(wide.querySelector('.pws-sprite')?.getAttribute('src')).toBe('/palco/characters/14-front.png');
    const at = wide.querySelector('.pws-at--feet') as HTMLElement;
    expect(at.style.getPropertyValue('--x')).toBe(String(SCENES['join-wide'].stand!.cx));
    expect(at.style.getPropertyValue('--y')).toBe(String(SCENES['join-wide'].stand!.feet));
  });

  it('shows nobody on the floor without a pick', () => {
    const { container } = render(<PalcoScene kind="join" />);
    expect(container.querySelector('.pws-sprite')).toBeNull();
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
