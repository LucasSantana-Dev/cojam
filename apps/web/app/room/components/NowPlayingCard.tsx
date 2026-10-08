'use client';

// "Tocando agora": the now-playing card of the room (#325, round 4), laid out as
// in the approved mockup. Left: the cover with its halo and, under it, the
// service icons (which are the "Ouvir no" picker) and the overflow menu. Right:
// kicker, big title, artist, who asked, the progress bar and, under it, the
// transport centred with the local volume at the right end. The unavailable,
// failed and empty states keep this exact geometry: a cover placeholder and the
// message in the text column, and the next button for whoever can control.
// The card carries the one violet glow of the room.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TrackRef } from '@cojam/shared';
import { setRadio, nowPlayingAdvance } from '@/lib/realtime';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import { MoreVertIcon, MusicNoteIcon, SkipNextIcon } from '@/app/components/icons';
import type { IPlayer } from '@/lib/playerInterface';
import { TransportUI } from './TransportUI';
import { UnavailableTrack } from './UnavailableTrack';
import { PlayFailedTrack } from './PlayFailedTrack';

function RadioSwitch({ roomId, on }: { roomId: string; on: boolean }) {
  return (
    <label className="r4-menu__item r4-radio" title="Toca músicas parecidas quando a fila acaba">
      <input type="checkbox" checked={on} onChange={(e) => setRadio(roomId, e.target.checked)} className="sr-only" />
      <span>Rádio</span>
      <span className="r4-radio__track" data-on={on} aria-hidden="true">
        <span className="r4-radio__thumb" />
      </span>
    </label>
  );
}

// The "⋮" under the cover: Detalhes, Letra, Mais and the radio switch. Stays
// mounted while closed (hidden), so the radio checkbox keeps its state.
function OverflowMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="r4-now__more" ref={wrapRef}>
      <button
        type="button"
        className="r4-iconbtn"
        aria-label="Mais opções da faixa"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreVertIcon size={22} />
      </button>
      <div className="r4-menu r4-menu--up" hidden={!open} onClick={() => setOpen(false)}>
        {children}
      </div>
    </div>
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
  // The service icons ("Ouvir no"); rendered under the cover.
  servicePicker?: ReactNode;
  // The "chosen service cannot play this" note, under the icons.
  serviceNote?: ReactNode;
  // Local volume and mute; shown whether or not sync (transport) is on.
  volumeControl?: ReactNode;
  activePlayer: IPlayer | null;
  radioOn: boolean;
  // false when the server cannot refill a radio queue: the switch is hidden.
  radioAvailable?: boolean;
  onOpenDepth: () => void;
  onOpenLyrics: () => void;
  onOpenEnrichment: () => void;
  // Pre-join preview: the same card, nothing to operate.
  preview?: boolean;
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
  servicePicker,
  serviceNote,
  volumeControl,
  activePlayer,
  radioOn,
  radioAvailable = true,
  onOpenDepth,
  onOpenLyrics,
  onOpenEnrichment,
  preview = false,
}: NowPlayingCardProps) {
  const f = useRuntimeFeatures();
  const ok = Boolean(track) && state === 'ok';
  const showTransport = ok && f.sync;

  const tools = preview
    ? []
    : [
        ok && f.trackDepth && (
          <button key="depth" type="button" onClick={onOpenDepth} className="r4-menu__item" title="Ver detalhes da faixa no MusicBrainz">
            Detalhes
          </button>
        ),
        ok && f.lyrics && (
          <button key="lyrics" type="button" onClick={onOpenLyrics} className="r4-menu__item" title="Ver a letra desta faixa">
            Letra
          </button>
        ),
        ok && (f.listenBrainz || f.lastfmEnrich) && (
          <button key="more" type="button" onClick={onOpenEnrichment} className="r4-menu__item" title="Ver dados extras do ListenBrainz e do Last.fm">
            Mais
          </button>
        ),
        radioAvailable && <RadioSwitch key="radio" roomId={roomId} on={radioOn} />,
      ].filter(Boolean);

  // Same row as the transport, for the states that have none: next (controllers
  // only) and the volume.
  const fallbackRow = (
    <div className="tp__row">
      <span className="tp__side" aria-hidden="true" />
      <div className="tp__ctrls">
        {track && hostControl && !preview && (
          <button
            type="button"
            className="tp__skip"
            aria-label="Próxima faixa"
            title="Próxima faixa"
            onClick={() => nowPlayingAdvance(roomId, track.id).catch((err) => console.error('Skip error:', err))}
          >
            <SkipNextIcon size={24} />
          </button>
        )}
      </div>
      <span className="tp__side tp__side--end">{preview ? null : volumeControl}</span>
    </div>
  );

  return (
    <section className={`r4-card r4-now${track && isPlaying ? ' is-live' : ''}`} aria-label="Tocando agora" data-state={track ? state : 'empty'}>
      <div className="r4-now__grid">
        <div className="r4-cover" aria-hidden>
          {track && artwork && coverLevel < 2 && state === 'ok' ? (
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
            <span className="r4-cover__fallback">
              {track ? track.title.charAt(0).toUpperCase() : <MusicNoteIcon size={56} />}
            </span>
          )}
        </div>

        <div className="r4-now__info">
          {track ? (
            <>
              <p className="r4-kicker">
                {isPlaying ? 'Tocando agora' : transportState === 'stopped' ? 'Parado' : 'Pausado'}
                {hostLabel && <span className="host-chip">Anfitrião</span>}
              </p>
              {state === 'unavailable' ? (
                <UnavailableTrack />
              ) : state === 'failed' ? (
                <PlayFailedTrack />
              ) : (
                <div key={track.id} className="track-change-enter">
                  <h2 className="r4-now__title">{track.title}</h2>
                  <p className="r4-now__artist">{track.artist}</p>
                </div>
              )}
              {ok && (
                <div className="r4-now__meta">
                  <span className="r4-chip">{track.addedBy} pediu</span>
                </div>
              )}
            </>
          ) : (
            <div className="hero-empty r4-now__empty">
              <p className="r4-kicker">Tocando agora</p>
              <p className="r4-now__title r4-now__title--empty">Nada tocando ainda</p>
              <p className="r4-now__artist r4-now__artist--wrap">Adicione uma faixa para começar a sessão.</p>
            </div>
          )}
        </div>

        {showTransport ? (
          <TransportUI roomId={roomId} activePlayer={activePlayer} canControl={hostControl && !preview} trailing={preview ? null : volumeControl} />
        ) : (
          fallbackRow
        )}

        <div className="r4-now__svc">
          {servicePicker}
          {tools.length > 0 && <OverflowMenu>{tools}</OverflowMenu>}
        </div>
        {serviceNote && <div className="r4-now__note">{serviceNote}</div>}
      </div>
    </section>
  );
}
