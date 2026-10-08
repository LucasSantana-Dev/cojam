'use client';

// "Tocando agora": the now-playing card of the room (#325, round 4). Cover with a
// soft halo, kicker, big title, artist, who asked, progress and the transport,
// and under it the service this client plays through plus the host and
// enrichment tools. The card carries the one violet glow of the room.
import type { ReactNode } from 'react';
import type { TrackRef } from '@cojam/shared';
import { setRadio } from '@/lib/realtime';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import { platformIcon } from '@/app/components/icons';
import type { IPlayer } from '@/lib/playerInterface';
import { TransportUI } from './TransportUI';
import { UnavailableTrack } from './UnavailableTrack';
import { PlayFailedTrack } from './PlayFailedTrack';

const SOURCE_NAME = { youtube: 'YouTube', spotify: 'Spotify', apple: 'Apple Music' } as const;

// mm:ss for the shared room-age clock.
function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// The service this client plays the track through: a monochrome white glyph and
// the name, never the brand colour.
function SourceLabel({ source }: { source: keyof typeof SOURCE_NAME }) {
  const Icon = platformIcon[source];
  return (
    <span className="r4-source">
      <Icon size={16} />
      {SOURCE_NAME[source]}
    </span>
  );
}

function RadioSwitch({ roomId, on }: { roomId: string; on: boolean }) {
  return (
    <label className="r4-radio" title="Toca músicas parecidas quando a fila acaba">
      <input type="checkbox" checked={on} onChange={(e) => setRadio(roomId, e.target.checked)} className="sr-only" />
      <span>Rádio</span>
      <span className="r4-radio__track" data-on={on} aria-hidden="true">
        <span className="r4-radio__thumb" />
      </span>
    </label>
  );
}

interface NowPlayingCardProps {
  roomId: string;
  track: TrackRef | undefined;
  // This client cannot play the track (no source), or its provider failed.
  state: 'ok' | 'unavailable' | 'failed';
  artwork: string | null;
  coverLevel: number;
  onCoverError: () => void;
  isPlaying: boolean;
  transportState: string | undefined;
  hostControl: boolean;
  // Show the "Anfitrião" chip (room auth on and this client is the host).
  hostLabel: boolean;
  activeSource: keyof typeof SOURCE_NAME | null;
  // The "Ouvir no" control; replaces the plain source label when given.
  servicePicker?: ReactNode;
  // Local volume and mute; shown whether or not sync (transport) is on.
  volumeControl?: ReactNode;
  activePlayer: IPlayer | null;
  roomAgeS: number | null;
  radioOn: boolean;
  onOpenDepth: () => void;
  onOpenLyrics: () => void;
  onOpenEnrichment: () => void;
}

export function NowPlayingCard({
  roomId,
  track,
  state,
  artwork,
  coverLevel,
  onCoverError,
  isPlaying,
  transportState,
  hostControl,
  hostLabel,
  activeSource,
  servicePicker,
  volumeControl,
  activePlayer,
  roomAgeS,
  radioOn,
  onOpenDepth,
  onOpenLyrics,
  onOpenEnrichment,
}: NowPlayingCardProps) {
  const f = useRuntimeFeatures();

  return (
    <section className={`r4-card r4-now${track && isPlaying ? ' is-live' : ''}`} aria-label="Tocando agora">
      {track && state === 'unavailable' ? (
        <>
          <UnavailableTrack />
          <div className="r4-now__foot">
            {servicePicker}
            <span className="r4-now__tools">
              <RadioSwitch roomId={roomId} on={radioOn} />
            </span>
          </div>
        </>
      ) : track && state === 'failed' ? (
        <>
          <PlayFailedTrack />
          <div className="r4-now__foot">
            {servicePicker}
            <span className="r4-now__tools">
              <RadioSwitch roomId={roomId} on={radioOn} />
            </span>
          </div>
        </>
      ) : track ? (
        <>
          <div className="r4-now__grid">
            <div className="r4-cover" aria-hidden>
              {artwork && coverLevel < 2 ? (
                <>
                  {/* the cover's own soft halo: the same image, blurred behind it */}
                  {/* eslint-disable-next-line @next/next/no-img-element -- decorative copy of the cover */}
                  <img src={artwork} alt="" className="r4-cover__halo" />
                  {/* eslint-disable-next-line @next/next/no-img-element -- plain <img> keeps the cover loading from any host */}
                  <img
                    key={`${artwork}|${coverLevel}`}
                    src={artwork}
                    alt=""
                    className="r4-cover__img"
                    // load failed: fall back to the placeholder
                    onError={onCoverError}
                  />
                </>
              ) : (
                <span className="r4-cover__fallback">{track.title.charAt(0).toUpperCase()}</span>
              )}
            </div>
            <div className="r4-now__text">
              <p className="r4-kicker">
                {isPlaying ? 'Tocando agora' : transportState === 'stopped' ? 'Parado' : 'Pausado'}
                {hostLabel && <span className="host-chip">Anfitrião</span>}
              </p>
              <div key={track.id} className="track-change-enter">
                <h2 className="r4-now__title">{track.title}</h2>
                <p className="r4-now__artist">{track.artist}</p>
              </div>
              <div className="r4-now__meta">
                <span className="r4-chip">{track.addedBy} pediu</span>
                {roomAgeS !== null && <span className="np-timer">na sala há {formatElapsed(roomAgeS)}</span>}
              </div>
              {f.sync && (
                <div className="r4-now__transport">
                  <TransportUI roomId={roomId} activePlayer={activePlayer} canControl={hostControl} />
                </div>
              )}
              {volumeControl}
            </div>
          </div>
          <div className="r4-now__foot">
            {servicePicker ?? (activeSource && <SourceLabel source={activeSource} />)}
            {servicePicker && activeSource && <SourceLabel source={activeSource} />}
            <span className="r4-now__tools">
              {f.trackDepth && (
                <button type="button" onClick={onOpenDepth} className="r4-ghost" title="Ver detalhes da faixa no MusicBrainz">
                  Detalhes
                </button>
              )}
              {f.lyrics && (
                <button type="button" onClick={onOpenLyrics} className="r4-ghost" title="Ver a letra desta faixa">
                  Letra
                </button>
              )}
              {(f.listenBrainz || f.lastfmEnrich) && (
                <button type="button" onClick={onOpenEnrichment} className="r4-ghost" title="Ver dados extras do ListenBrainz e do Last.fm">
                  Mais
                </button>
              )}
              <RadioSwitch roomId={roomId} on={radioOn} />
            </span>
          </div>
        </>
      ) : (
        <div className="hero-empty r4-now__empty">
          <p className="r4-now__title r4-now__title--empty">Nada tocando ainda</p>
          <p className="r4-now__artist">Adicione uma faixa para começar a sessão.</p>
          <RadioSwitch roomId={roomId} on={radioOn} />
        </div>
      )}
    </section>
  );
}
