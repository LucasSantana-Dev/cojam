import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrackDepthPanel } from './TrackDepthPanel';
import type { TrackRef } from '@cojam/shared';
import type { TrackDepth } from '@/lib/realtime';

// Only the RPC function is mocked; the component renders its real state flow.
const rpcMocks = vi.hoisted(() => ({
  fetchTrackDepth: vi.fn(),
}));

vi.mock('@/lib/realtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime')>()),
  fetchTrackDepth: rpcMocks.fetchTrackDepth,
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

describe('TrackDepthPanel retry', () => {
  beforeEach(() => {
    rpcMocks.fetchTrackDepth.mockReset();
  });

  it('refetches and renders credits after a failed fetch when Retry is clicked', async () => {
    rpcMocks.fetchTrackDepth.mockRejectedValueOnce(new Error('boom'));
    const depth: TrackDepth = {
      credits: [{ role: 'Producer', name: 'Rick Rubin' }],
      tags: [],
      source: 'musicbrainz',
    };
    rpcMocks.fetchTrackDepth.mockResolvedValue(depth);

    render(<TrackDepthPanel roomId="r1" track={track} open onClose={vi.fn()} />);

    expect(await screen.findByText('boom')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Rick Rubin')).toBeInTheDocument();
    expect(rpcMocks.fetchTrackDepth).toHaveBeenCalledTimes(2);
  });
});
