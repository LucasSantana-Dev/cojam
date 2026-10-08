import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ListeningServicePicker, ServiceFallbackNote, type ListeningServicePickerProps } from './ListeningServicePicker';

function setup(over: Partial<ListeningServicePickerProps> = {}) {
  const props: ListeningServicePickerProps = {
    preference: 'auto',
    onChange: vi.fn(),
    spotifyEnabled: true,
    spotifyConnected: true,
    onConnectSpotify: vi.fn(),
    variant: 'list',
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
    expect(screen.getByRole('button', { name: 'YouTube' })).toBeInTheDocument();
  });

  it('selects a service on click', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: 'YouTube' }));
    expect(p.onChange).toHaveBeenCalledWith('youtube');
  });

  it('offers to connect Spotify instead of selecting it', () => {
    const p = setup({ spotifyConnected: false });
    const btn = screen.getByRole('button', { name: 'Conectar Spotify' });
    expect(btn).not.toHaveAttribute('aria-pressed');
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

  it('as icons: no Automático, and the effective service is highlighted while the choice is auto', () => {
    setup({ variant: 'icons', preference: 'auto', effective: 'spotify' });
    expect(screen.queryByRole('button', { name: 'Automático' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Spotify' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'YouTube' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('as icons: clicking one sets the listening choice', () => {
    const p = setup({ variant: 'icons' });
    fireEvent.click(screen.getByRole('button', { name: 'YouTube' }));
    expect(p.onChange).toHaveBeenCalledWith('youtube');
  });
});

describe('ServiceFallbackNote', () => {
  it('says so when the chosen service fell back', () => {
    render(<ServiceFallbackNote fallback={{ wanted: 'spotify', playing: 'youtube', reason: 'no-version' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Esta faixa não tem versão no Spotify, tocando no YouTube.');
  });

  it('says the service is not connected when that is the cause', () => {
    render(<ServiceFallbackNote fallback={{ wanted: 'spotify', playing: 'youtube', reason: 'not-connected' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Spotify não conectado, tocando no YouTube.');
  });
});
