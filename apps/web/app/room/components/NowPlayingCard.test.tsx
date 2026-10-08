import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TrackRef } from '@cojam/shared';
import { NowPlayingCard } from './NowPlayingCard';

vi.mock('@/lib/useRuntimeFeatures', () => ({
  useRuntimeFeatures: () => ({ sync: false, trackDepth: false, lyrics: false, listenBrainz: false, lastfmEnrich: false }),
}));
vi.mock('@/lib/realtime', () => ({ setRadio: vi.fn() }));

const track = { id: 't1', title: 'Song', artist: 'Band', addedBy: 'Ana' } as unknown as TrackRef;

function renderCard(state: 'ok' | 'unavailable' | 'failed', radioAvailable = true) {
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
      activePlayer={null}
      radioOn={false}
      radioAvailable={radioAvailable}
      onOpenDepth={() => {}}
      onOpenLyrics={() => {}}
      onOpenEnrichment={() => {}}
    />,
  );
}

describe('NowPlayingCard overflow menu', () => {
  it.each(['ok', 'unavailable', 'failed'] as const)('keeps the Rádio switch in the %s state', (state) => {
    renderCard(state);
    fireEvent.click(screen.getByRole('button', { name: 'Mais opções da faixa' }));
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByText('Rádio')).toBeInTheDocument();
  });

  it('hides the Rádio switch (and the empty menu) when the server cannot refill a radio', () => {
    renderCard('ok', false);
    expect(screen.queryByRole('button', { name: 'Mais opções da faixa' })).toBeNull();
  });

  it('keeps one card geometry: cover placeholder and message in the text column', () => {
    const { container } = renderCard('unavailable');
    expect(container.querySelector('.r4-cover')).not.toBeNull();
    expect(container.querySelector('.r4-now__info')).toHaveTextContent('Indisponível nos serviços conectados');
  });
});
