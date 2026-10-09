import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { PublicRoomSummary } from '@cojam/shared';
import RoomsPage from './page';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock('@/lib/telemetry', () => ({ trackEvent: vi.fn() }));

const mocks = vi.hoisted(() => ({
  publicRooms: true,
  listener: null as ((rooms: PublicRoomSummary[]) => void) | null,
  subscribed: 0,
}));

vi.mock('@/lib/useRuntimeFeatures', () => ({
  useRuntimeFeatures: () => ({ publicRooms: mocks.publicRooms }),
}));
vi.mock('@/lib/publicRooms', () => ({
  subscribePublicRooms: (listener: (rooms: PublicRoomSummary[]) => void) => {
    mocks.listener = listener;
    mocks.subscribed++;
    listener([]); // synchronous seed, like the real module
    return () => {};
  },
}));

const NOW = Date.now();
const rooms: PublicRoomSummary[] = [
  { roomId: 'AAA111', name: 'Música Calma', memberCount: 2, kind: 'audio', lastActiveMs: NOW - 5 * 60_000 },
  { roomId: 'BBB222', name: 'Cinema Night', memberCount: 9, kind: 'video', lastActiveMs: NOW - 3_600_000 },
  { roomId: 'CCC333', memberCount: 5, kind: 'audio', lastActiveMs: NOW - 1_000 },
];

const names = () =>
  screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/room/'))
    .map((a) => within(a).getAllByText(/.+/)[0].textContent);

describe('RoomsPage', () => {
  beforeEach(() => {
    mocks.publicRooms = true;
    mocks.listener = null;
    mocks.subscribed = 0;
    localStorage.clear();
  });

  it('shows the disabled state and never subscribes when the flag is off', () => {
    mocks.publicRooms = false;
    render(<RoomsPage />);
    expect(screen.getByText(/não está disponível/)).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(mocks.subscribed).toBe(0);
  });

  it('shows the empty state after the first empty poll', () => {
    render(<RoomsPage />);
    act(() => mocks.listener!([]));
    expect(screen.getByText(/Nenhuma sala pública no ar/)).toBeInTheDocument();
    expect(screen.getByText('PALCO LIVRE')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Criar sala' }));
    expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/room\/[0-9A-Z]{12}$/));
  });

  it('reads AO VIVO only on a live room and shows the listener count', () => {
    render(<RoomsPage />);
    act(() => mocks.listener!(rooms));
    // CCC333 was active a second ago; the other two are older.
    expect(screen.getAllByText('AO VIVO')).toHaveLength(1);
    expect(screen.getByText('5 ouvindo')).toBeInTheDocument();
    expect(screen.getByText('9 ouvindo')).toBeInTheDocument();
  });

  it('puts the scene band on top with the LED reading AO VIVO', () => {
    const { container } = render(<RoomsPage />);
    expect(container.querySelector('.pws--band')).not.toBeNull();
    expect(container.querySelectorAll('.pws-led').length).toBe(2);
  });

  it('lists rooms by most people by default, with kind and join hrefs', () => {
    render(<RoomsPage />);
    act(() => mocks.listener!(rooms));
    expect(names()).toEqual(['Cinema Night', 'CCC333', 'Música Calma']);
    expect(screen.getByText('Vídeo')).toBeInTheDocument();
    expect(screen.getByText('9 ouvindo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Cinema Night/ })).toHaveAttribute('href', '/room/BBB222');
  });

  it('sorts by most recent', () => {
    render(<RoomsPage />);
    act(() => mocks.listener!(rooms));
    fireEvent.click(screen.getByRole('button', { name: 'Mais recentes' }));
    expect(screen.getByRole('button', { name: 'Mais recentes' })).toHaveAttribute('aria-pressed', 'true');
    expect(names()).toEqual(['CCC333', 'Música Calma', 'Cinema Night']);
  });

  it('filters by name, ignoring case and accents, and by room code', () => {
    render(<RoomsPage />);
    act(() => mocks.listener!(rooms));
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: 'musica' } });
    expect(names()).toEqual(['Música Calma']);
    fireEvent.change(box, { target: { value: 'ccc' } });
    expect(names()).toEqual(['CCC333']);
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText(/Nenhuma sala encontrada/)).toBeInTheDocument();
  });

  it('offers a report control per card that does not navigate (#259)', () => {
    render(<RoomsPage />);
    act(() => mocks.listener!(rooms));
    const btn = screen.getByRole('button', { name: 'Denunciar sala Cinema Night' });
    expect(btn.closest('a')).toBeNull();
    fireEvent.click(btn);
    expect(screen.getByRole('heading', { name: 'Denunciar sala' })).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
