import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EnrichmentPanel } from './EnrichmentPanel';
import type { TrackRef } from '@cojam/shared';
import type { ListenBrainzEnrichment, LastfmEnrich } from '@/lib/realtime';

// Only the RPC functions are mocked; the component renders its real state flow.
const rpcMocks = vi.hoisted(() => ({
  fetchListenBrainz: vi.fn(),
  fetchLastfmEnrich: vi.fn(),
}));

vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  fetchListenBrainz: rpcMocks.fetchListenBrainz,
  fetchLastfmEnrich: rpcMocks.fetchLastfmEnrich,
}));

vi.mock('@/lib/useRuntimeFeatures', () => ({
  useRuntimeFeatures: () => ({ listenBrainz: true, lastfmEnrich: true }),
}));

const track: TrackRef = {
  id: 't1',
  title: 'Song',
  artist: 'A',
  durationMs: 60000,
  isrc: 'USRC17607839',
  sources: {},
  addedBy: 'Ana',
};

describe('EnrichmentPanel retry', () => {
  beforeEach(() => {
    rpcMocks.fetchListenBrainz.mockReset();
    rpcMocks.fetchLastfmEnrich.mockReset();
    const lfm: LastfmEnrich = { playcount: 0, listeners: 0, tags: [], source: 'lastfm' };
    rpcMocks.fetchLastfmEnrich.mockResolvedValue(lfm);
  });

  it('refetches only the failed section and renders its data when Retry is clicked', async () => {
    rpcMocks.fetchListenBrainz.mockRejectedValueOnce(new Error('boom'));
    const lb: ListenBrainzEnrichment = { mbid: 'm1', tags: ['rock'], count: 42, source: 'listenbrainz' };
    rpcMocks.fetchListenBrainz.mockResolvedValue(lb);

    render(<EnrichmentPanel roomId="r1" track={track} open onClose={vi.fn()} />);

    expect(await screen.findByText('boom')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('rock')).toBeInTheDocument();
    expect(rpcMocks.fetchListenBrainz).toHaveBeenCalledTimes(2);
    // The healthy Last.fm section is not refetched by the ListenBrainz retry.
    expect(rpcMocks.fetchLastfmEnrich).toHaveBeenCalledTimes(1);
  });
});
