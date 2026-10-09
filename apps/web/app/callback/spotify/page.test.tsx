import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SpotifyCallback from './page';
import { SpotifyConnectError } from '@/lib/spotifyConnectError';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

const handleCallback = vi.fn();
const retryAuth = vi.fn(async () => {});
vi.mock('@/lib/spotifyAuth', () => ({
  handleCallback: (...a: unknown[]) => handleCallback(...a),
  retryAuth: () => retryAuth(),
}));

function at(search: string) {
  window.history.pushState({}, '', `/callback/spotify${search}`);
}

describe('Spotify callback page errors', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    handleCallback.mockReset();
    retryAuth.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says the user cancelled on ?error=access_denied', async () => {
    at('?error=access_denied&state=x');
    render(<SpotifyCallback />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Você cancelou a autorização no Spotify.');
    expect(handleCallback).not.toHaveBeenCalled();
  });

  it('explains a missing code as an interrupted authorization', async () => {
    at('');
    render(<SpotifyCallback />);
    expect(await screen.findByTestId('spotify-callback-error')).toHaveTextContent('expirou');
  });

  it('shows the server message when the exchange fails with a server error', async () => {
    at('?code=abc&state=x');
    handleCallback.mockRejectedValue(new SpotifyConnectError('server'));
    render(<SpotifyCallback />);
    expect(await screen.findByRole('alert')).toHaveTextContent('erro do servidor');
  });

  it('shows the allowlist hint when Spotify rejects the exchange', async () => {
    at('?code=abc&state=x');
    handleCallback.mockRejectedValue(new SpotifyConnectError('rejected'));
    render(<SpotifyCallback />);
    expect(await screen.findByRole('alert')).toHaveTextContent('lista de testadores');
  });

  it('never prints the code or error detail on screen', async () => {
    at('?code=SECRETCODE&state=x');
    handleCallback.mockRejectedValue(new Error('token exchange failed SECRETCODE'));
    render(<SpotifyCallback />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('SECRETCODE');
  });

  it('offers a retry that restarts the flow', async () => {
    at('?code=abc&state=x');
    handleCallback.mockRejectedValue(new SpotifyConnectError('server'));
    render(<SpotifyCallback />);
    fireEvent.click(await screen.findByTestId('spotify-callback-retry'));
    await waitFor(() => expect(retryAuth).toHaveBeenCalledTimes(1));
  });

  const led = (container: HTMLElement) => container.querySelector('.pws__v--wide .pws-led')?.getAttribute('data-led');

  it('says CONECTANDO / SPOTIFY on the stage screen while it works', async () => {
    at('?code=abc&state=x');
    handleCallback.mockReturnValue(new Promise(() => {}));
    const { container } = render(<SpotifyCallback />);
    expect(led(container)).toBe('CONECTANDO / SPOTIFY');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Conectando o Spotify...');
  });

  it('says ERRO / SPOTIFY on failure and prints no code', async () => {
    at('?code=abc&state=x');
    handleCallback.mockRejectedValue(new SpotifyConnectError('server'));
    const { container } = render(<SpotifyCallback />);
    await screen.findByRole('alert');
    expect(led(container)).toBe('ERRO / SPOTIFY');
    expect(container.textContent).not.toMatch(/\b(4|5)\d\d\b|error=|code=/i);
  });
});
