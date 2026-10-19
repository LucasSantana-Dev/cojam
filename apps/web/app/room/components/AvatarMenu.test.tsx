import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AvatarMenu } from './AvatarMenu';

// Heavy child components are swapped for lightweight stubs.
vi.mock('@/lib/avatar', () => ({ avatarGradient: () => 'linear-gradient(black,white)' }));
vi.mock('@/lib/guestName', () => ({
  saveGuestName: vi.fn(),
  NAME_KEY: 'cojam_guest_name',
}));
vi.mock('./CharacterAvatar', () => ({
  CharacterAvatar: ({ initial }: { initial: string }) => <span data-testid="char-avatar">{initial}</span>,
}));
vi.mock('./CharacterPicker', () => ({
  CharacterPicker: () => <div data-testid="char-picker" />,
}));
vi.mock('@/app/components/ServiceBadge', () => ({
  ServiceBadge: ({ source }: { source: string }) => <span data-testid="service-badge">{source}</span>,
}));
vi.mock('@/app/components/YourDataId', () => ({
  YourDataId: () => <div data-testid="your-data-id" />,
}));
vi.mock('./ListeningServicePicker', () => ({
  ListeningServicePicker: () => <div data-testid="service-picker" />,
}));

import { saveGuestName } from '@/lib/guestName';

const defaults = {
  roomId: 'NEON42',
  name: 'Tester',
  seed: 'abc',
  characterId: 1,
  onCharacterChange: vi.fn(),
  platform: null as null | 'spotify' | 'youtube',
  serviceConnected: false,
  guest: false,
  accountsEnabled: false,
  picker: {
    value: null as null | 'spotify' | 'youtube',
    effective: null as null | 'spotify' | 'youtube',
    onChange: vi.fn(),
  },
  roomItems: null,
  connectors: null,
};

function renderMenu(props: Partial<typeof defaults> = {}) {
  return render(<AvatarMenu {...defaults} {...props} />);
}

describe('AvatarMenu', () => {
  const assignMock = vi.fn();
  const reloadMock = vi.fn();

  beforeEach(() => {
    assignMock.mockReset();
    reloadMock.mockReset();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        assign: assignMock,
        reload: reloadMock,
        href: 'http://localhost/room/NEON42',
        origin: 'http://localhost',
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders closed by default and opens on trigger click', () => {
    renderMenu();
    const panel = document.getElementById('r4-avatar-menu-NEON42');
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('hidden');

    fireEvent.click(screen.getByRole('button', { name: /Menu de Tester/i }));
    expect(panel).not.toHaveAttribute('hidden');
  });

  it('toggles closed when the trigger is clicked again', () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: /Menu de Tester/i });
    const panel = document.getElementById('r4-avatar-menu-NEON42')!;

    fireEvent.click(trigger);
    expect(panel).not.toHaveAttribute('hidden');

    fireEvent.click(trigger);
    expect(panel).toHaveAttribute('hidden');
  });

  it('closes on Escape and returns focus to the trigger', () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: /Menu de Tester/i });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.getElementById('r4-avatar-menu-NEON42')).not.toHaveAttribute('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.getElementById('r4-avatar-menu-NEON42')).toHaveAttribute('hidden');
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on outside click', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: /Menu de Tester/i }));
    const panel = document.getElementById('r4-avatar-menu-NEON42')!;
    expect(panel).not.toHaveAttribute('hidden');

    fireEvent.mouseDown(document.body);
    expect(panel).toHaveAttribute('hidden');
  });

  it('shows the guest chip when guest=true', () => {
    renderMenu({ guest: true });
    fireEvent.click(screen.getByRole('button', { name: /Menu de Tester/i }));
    expect(screen.getByText('Convidado')).toBeInTheDocument();
  });

  it('hides the guest chip when guest=false', () => {
    renderMenu({ guest: false });
    fireEvent.click(screen.getByRole('button', { name: /Menu de Tester/i }));
    expect(screen.queryByText('Convidado')).not.toBeInTheDocument();
  });

  it('shows the platform name when platform is set', () => {
    renderMenu({ platform: 'spotify' });
    fireEvent.click(screen.getByRole('button', { name: /Menu de Tester/i }));
    expect(screen.getByText(/Ouvindo no Spotify/)).toBeInTheDocument();
  });

  it('shows "conectado" chip when serviceConnected=true', () => {
    renderMenu({ platform: 'spotify', serviceConnected: true });
    fireEvent.click(screen.getByRole('button', { name: /Menu de Tester/i }));
    expect(screen.getByText('conectado')).toBeInTheDocument();
  });

  it('shows Minha conta link when accountsEnabled=true', () => {
    renderMenu({ accountsEnabled: true });
    fireEvent.click(screen.getByRole('button', { name: /Menu de Tester/i }));
    expect(screen.getByRole('link', { name: 'Minha conta' })).toBeInTheDocument();
  });

  it('hides Minha conta when accountsEnabled=false', () => {
    renderMenu({ accountsEnabled: false });
    fireEvent.click(screen.getByRole('button', { name: /Menu de Tester/i }));
    expect(screen.queryByRole('link', { name: 'Minha conta' })).not.toBeInTheDocument();
  });

  it('shows rename form on Trocar nome click and saves on submit', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: /Menu de Tester/i }));
    fireEvent.click(screen.getByRole('button', { name: /Trocar nome/i }));

    const input = screen.getByRole('textbox', { name: /Novo nome/i });
    expect(input).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'NovNome' } });
    fireEvent.submit(input.closest('form')!);

    expect(saveGuestName).toHaveBeenCalledWith('NovNome');
    expect(reloadMock).toHaveBeenCalled();
  });

  it('does not reload if the name is unchanged on rename submit', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: /Menu de Tester/i }));
    fireEvent.click(screen.getByRole('button', { name: /Trocar nome/i }));

    const form = screen.getByRole('textbox', { name: /Novo nome/i }).closest('form')!;
    // Input starts at the current name "Tester"; submit without changing.
    fireEvent.submit(form);

    expect(saveGuestName).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('Sair da sala navigates to origin', () => {
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem');
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: /Menu de Tester/i }));
    fireEvent.click(screen.getByRole('button', { name: /Sair da sala/i }));

    expect(removeItemSpy).toHaveBeenCalledWith('cojam_guest_name');
    expect(assignMock).toHaveBeenCalledWith('http://localhost/');
  });

  it('toggles character picker section with aria-expanded', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: /Menu de Tester/i }));

    const btn = screen.getByRole('button', { name: /Trocar personagem/i });
    expect(btn).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('char-picker')).toBeInTheDocument();
  });

  it('toggles service picker section with aria-expanded', () => {
    renderMenu({ platform: 'youtube' });
    fireEvent.click(screen.getByRole('button', { name: /Menu de Tester/i }));

    const btn = screen.getByRole('button', { name: /Trocar serviço/i });
    expect(btn).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('service-picker')).toBeInTheDocument();
  });

  it('renders the YourDataId and roomItems slots', () => {
    renderMenu({ roomItems: <button>room-action</button> });
    fireEvent.click(screen.getByRole('button', { name: /Menu de Tester/i }));
    expect(screen.getByTestId('your-data-id')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'room-action' })).toBeInTheDocument();
  });
});
