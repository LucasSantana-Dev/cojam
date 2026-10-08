import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SpotifyProblemNote } from './SpotifyProblemNote';

describe('SpotifyProblemNote', () => {
  it('tells Brave users to enable Widevine and offers YouTube', () => {
    const youtube = vi.fn();
    render(<SpotifyProblemNote kind="sdk" onUseYouTube={youtube} />);
    expect(screen.getByRole('alert')).toHaveTextContent('brave://settings/extensions');
    expect(screen.getByRole('alert')).toHaveTextContent('Widevine');
    fireEvent.click(screen.getByRole('button', { name: 'Tocar pelo YouTube' }));
    expect(youtube).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Tocar no Spotify' })).toBeNull();
  });

  it('states Premium is required', () => {
    render(<SpotifyProblemNote kind="premium" />);
    expect(screen.getByRole('alert')).toHaveTextContent('precisa de uma conta Premium');
  });

  it('gives a visible click target for the autoplay gesture', () => {
    const retry = vi.fn();
    render(<SpotifyProblemNote kind="autoplay" onRetry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tocar no Spotify' }));
    expect(retry).toHaveBeenCalled();
  });
});
