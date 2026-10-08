'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { PublicRoomSummary } from '@cojam/shared';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import { subscribePublicRooms } from '@/lib/publicRooms';
import { AGE_GATE_COPY_PT, useAgeGatedJoin } from '@/app/components/useAgeGatedJoin';
import { useReportDialog } from '@/app/components/useReportDialog';
import { LiveCounter } from '@/app/components/LiveCounter';
import { SintoniaScreen, SineLine } from '@/app/components/SintoniaScreen';

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
    <SintoniaScreen>
    <main id="main" className="rooms-page">
      <header className="rooms-page__head">
        <div>
          <h1 className="rooms-page__title">Salas públicas</h1>
          <p className="rooms-page__sub">Salas abertas tocando agora. Entre em uma e ouça junto.</p>
          <LiveCounter />
        </div>
        <Link href="/" className="sx-link">&larr; Início</Link>
      </header>
      <SineLine className="sx-wave--wide" />

      {!features.publicRooms ? (
        <p className="rooms-page__empty sx-glass" role="status">
          O diretório de salas públicas não está disponível neste servidor.
        </p>
      ) : (
        <>
          <div className="rooms-page__toolbar">
            <input
              type="search"
              aria-label="Buscar salas"
              placeholder="Buscar por nome"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="rooms-page__search"
            />
            <label className="rooms-page__sort">
              <span>Ordenar</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                <option value="people">Mais pessoas</option>
                <option value="recent">Mais recentes</option>
              </select>
            </label>
          </div>

          {!loaded ? (
            <p className="rooms-page__empty sx-glass" role="status">Carregando salas...</p>
          ) : rooms.length === 0 ? (
            <p className="rooms-page__empty sx-glass" role="status">
              Nenhuma sala pública no ar agora. Crie uma e ative a opção Public.
            </p>
          ) : visible.length === 0 ? (
            <p className="rooms-page__empty sx-glass" role="status">Nenhuma sala encontrada para essa busca.</p>
          ) : (
            <div className="live-rooms__grid">
              {visible.map((room) => (
                <div key={room.roomId} className="live-room-wrap">
                <Link
                  href={`/room/${room.roomId}`}
                  className="live-room-card"
                  onClick={(e) => onCardClick(e, room.roomId)}
                >
                  <span className="live-room-card__top">
                    <span className="live-room-card__name">{room.name || room.roomId}</span>
                    <span className="sx-kind">{room.kind === 'video' ? 'Vídeo' : 'Áudio'}</span>
                  </span>
                  <span className="live-room-card__track">
                    {room.nowPlaying ? (
                      <>
                        <span className="live-room-card__title">{room.nowPlaying.title}</span>
                        <span className="live-room-card__artist">{room.nowPlaying.artist}</span>
                      </>
                    ) : (
                      <span className="live-room-card__artist">Nada tocando ainda</span>
                    )}
                  </span>
                  <span className="live-room-card__bottom">
                    <span className="live-room-card__count">
                      {room.memberCount} ouvindo
                    </span>
                    <span className="live-room-card__artist live-room-card__when">
                      {activeLabel(room.lastActiveMs, now) === 'ativa agora' && <span className="room-card__dot" aria-hidden="true" />}
                      {activeLabel(room.lastActiveMs, now)}
                    </span>
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
              ))}
            </div>
          )}
        </>
      )}

      {gate}
      {report.dialog}
    </main>
    </SintoniaScreen>
  );
}
