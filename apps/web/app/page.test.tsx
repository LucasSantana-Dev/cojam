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

  it('keeps Create room disabled until a name is typed', () => {
    render(<Home />);
    const btn = screen.getByRole('button', { name: 'Create room' });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: '  ' } });
    expect(btn).toBeDisabled();
  });

  it('stores the trimmed name under the room join key and routes to a new room', () => {
    render(<Home />);
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: ' Ana ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    expect(sessionStorage.getItem(NAME_KEY)).toBe('Ana');
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatch(/^\/room\/[0-9A-Z]{12}$/);
  });

  it('prefills the name saved by an earlier room join', () => {
    sessionStorage.setItem(NAME_KEY, 'Lucas');
    render(<Home />);
    expect(screen.getByLabelText('Your name')).toHaveValue('Lucas');
  });

  it('still joins an existing room by code', () => {
    render(<Home />);
    fireEvent.change(screen.getByPlaceholderText('Room code'), { target: { value: 'abc123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(push).toHaveBeenCalledWith('/room/ABC123');
  });
});
