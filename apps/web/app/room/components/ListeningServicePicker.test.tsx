import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ListeningServicePicker, type ListeningServicePickerProps } from './ListeningServicePicker';

function setup(over: Partial<ListeningServicePickerProps> = {}) {
  const props: ListeningServicePickerProps = {
    preference: 'auto',
    onChange: vi.fn(),
    spotifyEnabled: true,
    appleEnabled: false,
    spotifyConnected: true,
    appleConnected: false,
    onConnectSpotify: vi.fn(),
    ...over,
  };
  render(<ListeningServicePicker {...props} />);
  return props;
}

describe('ListeningServicePicker', () => {
  it('marks only the chosen segment with aria-pressed', () => {
    setup({ preference: 'youtube' });
    expect(screen.getByRole('button', { name: 'YouTube' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Spotify' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Automático' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders only the services available to this person', () => {
    setup({ spotifyEnabled: false });
    expect(screen.queryByRole('button', { name: /Spotify/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apple Music' })).toBeNull();
    expect(screen.getByRole('button', { name: 'YouTube' })).toBeInTheDocument();
  });

  it('shows Apple Music only when enabled and connected', () => {
    setup({ appleEnabled: true, appleConnected: false });
    expect(screen.queryByRole('button', { name: 'Apple Music' })).toBeNull();
  });

  it('shows Apple Music when enabled and connected', () => {
    setup({ appleEnabled: true, appleConnected: true });
    expect(screen.getByRole('button', { name: 'Apple Music' })).toBeInTheDocument();
  });

  it('selects a service on click', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: 'YouTube' }));
    expect(p.onChange).toHaveBeenCalledWith('youtube');
  });

  it('offers to connect Spotify instead of selecting it', () => {
    const p = setup({ spotifyConnected: false });
    const btn = screen.getByRole('button', { name: 'Conectar Spotify' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(btn);
    expect(p.onConnectSpotify).toHaveBeenCalled();
    expect(p.onChange).not.toHaveBeenCalled();
  });

  it('uses real buttons, so keyboard focus and activation come for free', () => {
    setup();
    const buttons = screen.getAllByRole('button');
    for (const b of buttons) {
      expect(b.tagName).toBe('BUTTON');
      expect(b).toHaveAttribute('type', 'button');
      expect(b).not.toHaveAttribute('tabindex', '-1');
    }
  });

  it('says so when the chosen service fell back', () => {
    setup({ preference: 'spotify', fallback: { wanted: 'spotify', playing: 'youtube' } });
    expect(screen.getByRole('status')).toHaveTextContent('Esta faixa não tem versão no Spotify, tocando no YouTube.');
  });

  it('has no note without a fallback', () => {
    setup();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
