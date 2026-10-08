import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Home from './page';
import { NAME_KEY } from '@/lib/guestName';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (p: { alt: string; src: string }) => <img alt={p.alt} src={p.src} />,
}));
// GSAP is dynamically imported client-side only; the page tolerates failure.
vi.mock('gsap', () => {
  throw new Error('no gsap in jsdom');
});
vi.mock('@/app/components/LiveRoomsStrip', () => ({
  LiveRoomsSlot: ({ fallback }: { fallback: React.ReactNode }) => <>{fallback}</>,
}));

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe('landing name + create', () => {
  beforeEach(() => {
    sessionStorage.clear();
    push.mockClear();
  });

  it('keeps Criar sala disabled until a name is typed', () => {
    render(<Home />);
    const btn = screen.getByRole('button', { name: 'Criar sala' });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Seu nome'), { target: { value: '  ' } });
    expect(btn).toBeDisabled();
  });

  it('stores the trimmed name under the room join key and routes to a new room', () => {
    render(<Home />);
    fireEvent.change(screen.getByLabelText('Seu nome'), { target: { value: ' Ana ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar sala' }));
    expect(sessionStorage.getItem(NAME_KEY)).toBe('Ana');
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatch(/^\/room\/[0-9A-Z]{12}$/);
  });

  it('prefills the name saved by an earlier room join', () => {
    sessionStorage.setItem(NAME_KEY, 'Lucas');
    render(<Home />);
    expect(screen.getByLabelText('Seu nome')).toHaveValue('Lucas');
  });

  it('still joins an existing room by code', () => {
    render(<Home />);
    fireEvent.change(screen.getByPlaceholderText('Código'), { target: { value: 'abc123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(push).toHaveBeenCalledWith('/room/ABC123');
  });

  it('renders the FAQ and a matching FAQPage JSON-LD', () => {
    const { container } = render(<Home />);
    const items = container.querySelectorAll('details.faq-item');
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(items.length).toBeLessThanOrEqual(7);
    const ld = Array.from(container.querySelectorAll('script[type="application/ld+json"]'))
      .map((n) => JSON.parse(n.textContent ?? '{}'))
      .find((d) => d['@type'] === 'FAQPage');
    expect(ld.mainEntity).toHaveLength(items.length);
    expect(ld.mainEntity[0]['@type']).toBe('Question');
  });

  it('has the 3-step section and never advertises unreleased features', () => {
    const { container } = render(<Home />);
    expect(screen.getByText('Como funciona em 3 passos')).toBeInTheDocument();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/compartilhar tela|screen share|vídeo/i);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});
