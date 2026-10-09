import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { YouTubeQuotaNote, quotaResetLabel } from './YouTubeQuotaNote';

afterEach(() => vi.useRealTimers());

describe('YouTubeQuotaNote', () => {
  it('shows the local reset hour while the quota is spent', () => {
    const until = Date.now() + 3_600_000;
    render(<YouTubeQuotaNote until={until} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      `Busca do YouTube esgotada hoje. Volta às ${quotaResetLabel(until)}.`,
    );
  });

  it('computes the hour in the viewer time zone, not a fixed one', () => {
    const until = new Date(2026, 6, 16, 4, 0, 0).getTime(); // 04:00 local
    expect(quotaResetLabel(until)).toBe('04h');
    expect(quotaResetLabel(new Date(2026, 6, 16, 4, 30, 0).getTime())).toBe('04h30');
    expect(quotaResetLabel(new Date(2026, 6, 16, 16, 0, 0).getTime())).toBe('16h');
  });

  it('renders nothing when the quota is available or already reset', () => {
    const { container, rerender } = render(<YouTubeQuotaNote />);
    expect(container).toBeEmptyDOMElement();
    rerender(<YouTubeQuotaNote until={Date.now() - 1000} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('hides itself when the reset time passes', () => {
    vi.useFakeTimers();
    const until = Date.now() + 5000;
    render(<YouTubeQuotaNote until={until} />);
    expect(screen.queryByTestId('youtube-quota-note')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByTestId('youtube-quota-note')).toBeNull();
  });
});
