import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VolumeControl } from './VolumeControl';
import { getVolume, setVolume } from '@/lib/volume';

describe('VolumeControl', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setVolume({ level: 0.8, muted: false });
  });

  it('exposes a labelled range and a mute toggle', () => {
    render(<VolumeControl />);
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('80');
    expect(screen.getByRole('button', { name: 'Silenciar' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('moving the slider saves the level and unmutes', () => {
    setVolume({ muted: true });
    render(<VolumeControl />);
    fireEvent.change(screen.getByRole('slider', { name: 'Volume' }), { target: { value: '35' } });
    expect(getVolume()).toEqual({ level: 0.35, muted: false });
  });

  it('the mute button toggles aria-pressed and keeps the level', () => {
    render(<VolumeControl />);
    const btn = screen.getByRole('button', { name: 'Silenciar' });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(getVolume()).toEqual({ level: 0.8, muted: true });
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('0');
  });
});
