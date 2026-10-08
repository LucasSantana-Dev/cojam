import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TrackRef } from '@cojam/shared';
import { NowPlayingCard } from './NowPlayingCard';

vi.mock('@/lib/useRuntimeFeatures', () => ({
  useRuntimeFeatures: () => ({ sync: false, trackDepth: false, lyrics: false, listenBrainz: false, lastfmEnrich: false }),
}));
vi.mock('@/lib/realtime', () => ({ setRadio: vi.fn() }));

const track = { id: 't1', title: 'Song', artist: 'Band', addedBy: 'Ana' } as unknown as TrackRef;

function renderCard(state: 'ok' | 'unavailable' | 'failed') {
  return render(
    <NowPlayingCard
      roomId="r"
      track={track}
      state={state}
      artwork={null}
      coverLevel={0}
      onCoverError={() => {}}
      isPlaying={false}
      transportState="paused"
      hostControl={false}
      hostLabel={false}
      activeSource={null}
      activePlayer={null}
      roomAgeS={null}
      radioOn={false}
      onOpenDepth={() => {}}
      onOpenLyrics={() => {}}
      onOpenEnrichment={() => {}}
    />,
  );
}

describe('NowPlayingCard radio switch', () => {
  it.each(['ok', 'unavailable', 'failed'] as const)('keeps the Rádio switch in the %s branch', (state) => {
    renderCard(state);
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByText('Rádio')).toBeInTheDocument();
  });
});
