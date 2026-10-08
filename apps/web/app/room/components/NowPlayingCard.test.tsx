import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TrackRef } from '@cojam/shared';
import { NowPlayingCard } from './NowPlayingCard';

vi.mock('@/lib/useRuntimeFeatures', () => ({
  useRuntimeFeatures: () => ({ sync: false, trackDepth: false, lyrics: false, listenBrainz: false, lastfmEnrich: false }),
}));
vi.mock('@/lib/realtime', () => ({ setRadio: vi.fn() }));

const track = { id: 't1', title: 'Song', artist: 'Band', addedBy: 'Ana' } as unknown as TrackRef;

function renderCard(state: 'ok' | 'unavailable' | 'failed', extra: { hostControl?: boolean; onNext?: () => void; radioAvailable?: boolean } = {}) {
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
      hostControl={extra.hostControl ?? false}
      onNext={extra.onNext}
      hostLabel={false}
      activePlayer={null}
      radioOn={false}
      radioAvailable={extra.radioAvailable ?? true}
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
    renderCard('ok', { radioAvailable: false });
    expect(screen.queryByRole('button', { name: 'Mais opções da faixa' })).toBeNull();
  });

  it('keeps one card geometry: cover placeholder and message in the text column', () => {
    const { container } = renderCard('unavailable');
    expect(container.querySelector('.r4-cover')).not.toBeNull();
    expect(container.querySelector('.r4-now__info')).toHaveTextContent('Indisponível nos serviços conectados');
  });
});

describe('NowPlayingCard unavailable track', () => {
  it('offers Próxima to anyone with control, so a dead track never sticks', () => {
    const onNext = vi.fn();
    renderCard('unavailable', { hostControl: true, onNext });
    screen.getByRole('button', { name: 'Próxima' }).click();
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('hides Próxima from plain listeners', () => {
    renderCard('unavailable', { hostControl: false, onNext: () => {} });
    expect(screen.queryByRole('button', { name: 'Próxima' })).not.toBeInTheDocument();
  });
});
