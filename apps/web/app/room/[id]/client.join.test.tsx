import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { RoomClient } from './client';
import { useStore } from '@/lib/realtime';
import { saveGuestName } from '@/lib/guestName';

// The pre-join screen is a palco screen (wave 2): the stage screen reads SALA and the real
// room code, the picked character stands on the floor and swaps live with the pick.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  joinRoom: vi.fn(async () => ({})),
}));
vi.mock('@/lib/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/account')>()),
  getAccountSession: vi.fn(async () => null),
  getConnectedServices: vi.fn(async () => []),
  getDisplayName: vi.fn(async () => null),
}));

const wide = () => document.querySelector('.pws__v--wide') as HTMLElement;
const floorSprite = () => wide().querySelector('img.pws-sprite') as HTMLImageElement;
const floorTag = () => wide().querySelector('.pws-tag--you') as HTMLElement;

describe('join screen (palco, wave 2)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    useStore.setState({ state: null, signedIn: false, name: '' });
  });

  it('puts SALA and the real room code on the stage screen', () => {
    render(<RoomClient roomId="DWB86HRONU22" />);
    const led = wide().querySelector('.pws-led');
    expect(led?.getAttribute('data-led')).toBe('SALA / DWB86HRONU22');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Entrar na sala');
    expect(screen.getByTestId('join-room-code')).toHaveTextContent('DWB86HRONU22');
  });

  it('shows the picked character on the floor and swaps it live with the pick', () => {
    render(<RoomClient roomId="DWB86HRONU22" />);
    fireEvent.click(screen.getByRole('radio', { name: /^Davi, / }));
    expect(floorSprite().getAttribute('src')).toBe('/palco/characters/09-front.png');
    expect(floorTag()).toHaveTextContent('Você · Davi');

    fireEvent.click(screen.getByRole('radio', { name: /^Luana, / }));
    expect(floorSprite().getAttribute('src')).toBe('/palco/characters/05-front.png');
    expect(floorTag()).toHaveTextContent('Você · Luana');
    // Static sprite swap: one still image, no animation hooks.
    expect(floorSprite().className).toBe('pws-sprite');
  });

  it('offers the whole roster of 14, Nico included', () => {
    render(<RoomClient roomId="DWB86HRONU22" />);
    const group = screen.getByRole('radiogroup');
    expect(within(group).getAllByRole('radio')).toHaveLength(14);
    fireEvent.click(within(group).getByRole('radio', { name: /^Nico, / }));
    expect(floorSprite().getAttribute('src')).toBe('/palco/characters/14-front.png');
  });

  it('draws no pixel art over the HUD: the join form is on a plate', () => {
    const { container } = render(<RoomClient roomId="DWB86HRONU22" />);
    expect(container.querySelector('form.pw-plate')).not.toBeNull();
    expect(container.querySelector('.ground-stack')).toBeNull();
  });
});

describe('removed-from-room screen (palco, wave 3)', () => {
  it('is a palco screen: FIM on the stage, an empty floor, one plate with the way home', async () => {
    sessionStorage.clear();
    localStorage.clear();
    useStore.setState({ state: null, signedIn: false, name: '', kicked: false });
    saveGuestName('Ana');
    const { container } = render(<RoomClient roomId="DWB86HRONU22" />);
    await act(async () => {});
    act(() => useStore.getState().setKicked(true));
    expect(wide().querySelector('.pws-led')?.getAttribute('data-led')).toBe('FIM / VOCE SAIU DA SALA');
    expect(wide().querySelector('img.pws-sprite')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Você foi removido da sala');
    expect(screen.getByText('O anfitrião removeu você desta sessão.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Voltar ao início' })).toHaveAttribute('href', '/');
    expect(container.querySelector('main.pw-plate')).not.toBeNull();
    expect(container.querySelector('.sx')).toBeNull();
    useStore.setState({ kicked: false });
  });
});
