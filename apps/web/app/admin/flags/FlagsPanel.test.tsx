import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { FlagsPanel } from './FlagsPanel';
import type { AdminFlagsState } from '@/lib/adminFlags';

const TOKEN = 't'.repeat(40);

function state(overrides: Partial<AdminFlagsState> = {}): AdminFlagsState {
  return {
    writable: true,
    pollSeconds: 15,
    changes: [],
    flags: [
      {
        name: 'roomChat',
        label: 'Chat da sala',
        help: 'Chat de texto.',
        default: false,
        serverEnv: { name: 'FEATURE_ROOM_CHAT', value: true },
        webEnv: 'COJAM_FEATURE_ROOM_CHAT',
        override: null,
        effective: { enabled: true, source: 'env', roomAllowlist: null },
      },
      {
        name: 'screenShare',
        label: 'Compartilhar tela',
        help: 'Tela.',
        default: false,
        serverEnv: { name: 'FEATURE_SCREENSHARE' },
        webEnv: 'COJAM_FEATURE_SCREENSHARE',
        allowlistEnv: { name: 'SCREENSHARE_ROOM_ALLOWLIST', rooms: [] },
        override: null,
        effective: { enabled: false, source: 'default', roomAllowlist: [], roomAllowlistSource: 'env' },
      },
    ],
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('FlagsPanel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sessionStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for the token, then lists the flags with where each value comes from', async () => {
    fetchMock.mockResolvedValueOnce(json(state()));
    render(<FlagsPanel />);
    fireEvent.change(screen.getByLabelText('Token de admin'), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByText('Chat da sala')).toBeInTheDocument();
    expect(screen.getByText(/pelo ambiente \(FEATURE_ROOM_CHAT ligado\)/)).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/flags');
    expect((init as RequestInit).headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    expect(sessionStorage.getItem('cojam.adminToken')).toBe(TOKEN);
  });

  it('saves an override with its note and reloads', async () => {
    sessionStorage.setItem('cojam.adminToken', TOKEN);
    fetchMock.mockResolvedValueOnce(json(state())).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json(state()));
    render(<FlagsPanel />);
    const row = (await screen.findByText('Chat da sala')).closest('li')!;
    const save = within(row).getByRole('button', { name: 'Salvar' });
    expect(save).toBeDisabled();
    fireEvent.click(within(row).getByRole('button', { name: 'Desligado' }));
    fireEvent.change(within(row).getByLabelText('Chat da sala: motivo da mudança'), { target: { value: 'spam' } });
    fireEvent.click(save);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('/api/admin/flags/roomChat');
    expect((init as RequestInit).method).toBe('PUT');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      enabled: false,
      roomAllowlist: null,
      note: 'spam',
    });
    expect(await screen.findByText('Mudança salva e aplicada no servidor.')).toBeInTheDocument();
  });

  it('sends the screen share room list normalized', async () => {
    sessionStorage.setItem('cojam.adminToken', TOKEN);
    fetchMock.mockResolvedValueOnce(json(state())).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json(state()));
    render(<FlagsPanel />);
    const row = (await screen.findByText('Compartilhar tela')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Ligado' }));
    fireEvent.click(within(row).getByRole('checkbox'));
    fireEvent.change(within(row).getByLabelText(/Códigos das salas/), { target: { value: 'abcdef123456\nabcdef123456, zyxwvu654321' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toMatchObject({
      enabled: true,
      roomAllowlist: ['ABCDEF123456', 'ZYXWVU654321'],
    });
  });

  it('drops a rejected token and says so', async () => {
    sessionStorage.setItem('cojam.adminToken', TOKEN);
    fetchMock.mockResolvedValueOnce(json({ error: 'Token de admin inválido.' }, 401));
    render(<FlagsPanel />);
    expect(await screen.findByText('Token de admin inválido.')).toBeInTheDocument();
    expect(sessionStorage.getItem('cojam.adminToken')).toBeNull();
    expect(screen.getByLabelText('Token de admin')).toBeInTheDocument();
  });

  it('explains a panel that is switched off', async () => {
    sessionStorage.setItem('cojam.adminToken', TOKEN);
    fetchMock.mockResolvedValueOnce(new Response('404 page not found', { status: 404 }));
    render(<FlagsPanel />);
    expect(await screen.findByText(/defina ADMIN_TOKEN/)).toBeInTheDocument();
  });
});
