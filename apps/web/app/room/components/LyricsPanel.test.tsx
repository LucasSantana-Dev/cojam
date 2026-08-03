import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LyricsPanel } from './LyricsPanel';
import type { TrackRef } from '@cojam/shared';
import type { Lyrics } from '@/lib/realtime';

// Only the RPC function is mocked; the component renders its real state flow.
const rpcMocks = vi.hoisted(() => ({
  fetchLyrics: vi.fn(),
}));

vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  fetchLyrics: rpcMocks.fetchLyrics,
}));

const track: TrackRef = {
  id: 't1',
  title: 'Song',
  artist: 'A',
  durationMs: 60000,
  sources: {},
  addedBy: 'Ana',
};

describe('LyricsPanel retry', () => {
  beforeEach(() => {
    rpcMocks.fetchLyrics.mockReset();
  });

  it('refetches and renders lyrics after a failed fetch when Retry is clicked', async () => {
    rpcMocks.fetchLyrics.mockRejectedValueOnce(new Error('boom'));
    const lyrics: Lyrics = { synced: [], plain: 'la la la', source: 'lrclib' };
    rpcMocks.fetchLyrics.mockResolvedValue(lyrics);

    render(<LyricsPanel roomId="r1" track={track} open onClose={vi.fn()} />);

    expect(await screen.findByText('boom')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('la la la')).toBeInTheDocument();
    expect(rpcMocks.fetchLyrics).toHaveBeenCalledTimes(2);
  });
});
