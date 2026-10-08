'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { PublicRoomSummary } from '@cojam/shared';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import { subscribePublicRooms } from '@/lib/publicRooms';
import { AGE_GATE_COPY_PT, useAgeGatedJoin } from '@/app/components/useAgeGatedJoin';
import { useReportDialog } from '@/app/components/useReportDialog';
import { LiveCounter } from '@/app/components/LiveCounter';
import { R4Brand, R4Footer } from '@/app/components/R4Shell';
import { MusicNoteIcon } from '@/app/components/icons';

type SortKey = 'people' | 'recent';

// If the first poll has not landed by then (unreachable server), stop showing
// the loading state and fall through to the empty state.
const LOADING_GRACE_MS = 3000;

// Accent- and case-insensitive match key ("Música" matches "musica").
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function filterAndSortRooms(
  rooms: PublicRoomSummary[],
  query: string,
  sort: SortKey,
): PublicRoomSummary[] {
  const q = fold(query.trim());
  const filtered = q
    ? rooms.filter((r) => fold(r.name || r.roomId).includes(q) || fold(r.roomId).includes(q))
    : rooms.slice();
  return filtered.sort((a, b) => {
    const primary =
      sort === 'people' ? b.memberCount - a.memberCount : b.lastActiveMs - a.lastActiveMs;
    return primary !== 0 ? primary : a.roomId.localeCompare(b.roomId);
  });
}

// "AO VIVO" only for a room that reported activity in the last 5 minutes;
// anything older shows its age instead of claiming to be live.
const LIVE_WINDOW_MS = 5 * 60_000;

function activeLabel(lastActiveMs: number, now: number): string {
  // Server and client clocks can disagree; never show a negative age.
  const seconds = Math.max(0, Math.floor((now - lastActiveMs) / 1000));
  if (seconds < 60) return 'ativa agora';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `ativa há ${minutes} min`;
  return `ativa há ${Math.floor(minutes / 60)} h`;
}

export function RoomsDirectory() {
  const features = useRuntimeFeatures();
  const { onCardClick, gate } = useAgeGatedJoin(AGE_GATE_COPY_PT);
  const report = useReportDialog();
  const [rooms, setRooms] = useState<PublicRoomSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('people');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!features.publicRooms) return;
    let calls = 0;
    const unsubscribe = subscribePublicRooms((next) => {
      // The first call is the synchronous seed (the last good list, possibly
      // empty); a later call is a real poll result.
      calls += 1;
      setRooms(next);
      setNow(Date.now());
      if (calls > 1 || next.length > 0) setLoaded(true);
    });
    const timer = setTimeout(() => setLoaded(true), LOADING_GRACE_MS);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [features.publicRooms]);

  const visible = useMemo(() => filterAndSortRooms(rooms, query, sort), [rooms, query, sort]);

  return (
    <div className="r4s">
      <header className="r4s-bar r4s-bar--rooms">
        <R4Brand />
      </header>
      <main id="main" className="r4s-main">
        <div className="r4s-rooms-head">
          <div className="r4s-rooms-head__row">
            <h1 className="r4s-h1">Salas ao vivo</h1>
            <LiveCounter className="r4s-pill" />
          </div>
          <p className="r4s-lede">Salas abertas tocando agora. Entre em uma e ouça junto.</p>
        </div>

        {!features.publicRooms ? (
          <p className="r4s-note" role="status">
            O diretório de salas públicas não está disponível neste servidor.
          </p>
        ) : (
          <>
            <div className="r4s-toolbar">
              <input
                type="search"
                aria-label="Buscar salas"
                placeholder="Buscar por nome"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="r4s-search"
              />
              <label className="r4s-sort">
                <span>Ordenar por</span>
                <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                  <option value="people">Mais pessoas</option>
                  <option value="recent">Mais recentes</option>
                </select>
              </label>
            </div>

            {!loaded ? (
              <p className="r4s-note" role="status">Carregando salas...</p>
            ) : rooms.length === 0 ? (
              <p className="r4s-note" role="status">
                Nenhuma sala pública no ar agora. Crie uma e ative a opção Pública.
              </p>
            ) : visible.length === 0 ? (
              <p className="r4s-note" role="status">Nenhuma sala encontrada para essa busca.</p>
            ) : (
              <div className="r4s-rooms">
                {visible.map((room) => {
                  const live = now - room.lastActiveMs <= LIVE_WINDOW_MS && room.memberCount > 0;
                  return (
                    <div key={room.roomId} className="r4s-room-wrap">
                      <Link
                        href={`/room/${room.roomId}`}
                        className="r4s-room"
                        aria-label={`Entrar na sala ${room.name || room.roomId}`}
                        onClick={(e) => onCardClick(e, room.roomId)}
                      >
                        <span className="r4s-room__top">
                          <span className="r4s-room__name">{room.name || room.roomId}</span>
                          {live && (
                            <span className="r4-live r4s-room__live">
                              <span className="r4-live__dot" aria-hidden />
                              AO VIVO
                            </span>
                          )}
                          {room.kind === 'video' && <span className="r4s-chip">Vídeo</span>}
                        </span>
                        <span className="r4s-room__main">
                          <span className="r4s-room__cover" aria-hidden>
                            <MusicNoteIcon size={28} />
                          </span>
                          <span className="r4s-room__track">
                            {room.nowPlaying ? (
                              <>
                                <span className="r4s-room__kicker">Tocando agora</span>
                                <span className="r4s-room__title">{room.nowPlaying.title}</span>
                                <span className="r4s-room__artist">{room.nowPlaying.artist}</span>
                              </>
                            ) : (
                              <span className="r4s-room__artist">Nada tocando ainda</span>
                            )}
                          </span>
                        </span>
                        <span className="r4s-room__bottom">
                          <span className="r4s-room__count">
                            <span>{room.memberCount} ouvindo</span>
                            {!live && <span className="r4s-room__when">{activeLabel(room.lastActiveMs, now)}</span>}
                          </span>
                          <span className="r4s-btn r4s-btn--sm" aria-hidden>Entrar</span>
                        </span>
                      </Link>
                      {/* A sibling of the link, not a child: a button inside an anchor is
                          invalid and would also navigate. */}
                      <button
                        type="button"
                        className="live-room-report"
                        aria-label={`Denunciar sala ${room.name || room.roomId}`}
                        onClick={() => report.open({ roomId: room.roomId, kind: 'room' })}
                      >
                        Denunciar
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {gate}
        {report.dialog}
      </main>
      <R4Footer />
    </div>
  );
}
