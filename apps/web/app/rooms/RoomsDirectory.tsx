'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { PublicRoomSummary } from '@cojam/shared';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import { subscribePublicRooms } from '@/lib/publicRooms';
import { AGE_GATE_COPY_PT, useAgeGatedJoin } from '@/app/components/useAgeGatedJoin';
import { useReportDialog } from '@/app/components/useReportDialog';
import { LiveCounter } from '@/app/components/LiveCounter';
import { PalcoNav, useCreateRoom } from '@/app/components/PalcoNav';
import { PalcoScene } from '@/app/components/PalcoScene';
import { PalcoBrandBar, PalcoFooter } from '@/app/components/PalcoShell';

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
  const createRoom = useCreateRoom();
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
    <div className="pw pwr">
      <PalcoBrandBar>
        <PalcoNav create current="rooms" />
      </PalcoBrandBar>
      <PalcoScene kind="band" led={{ title: 'AO VIVO', scale: 2, sub: 'SALAS ABERTAS' }} />
      <main id="main" className="pwr-main">
        <div className="pwr-head">
          <div className="pwr-head__row">
            <h1 className="pw-title pwr-title">Salas ao vivo</h1>
            <LiveCounter pill className="pwr-count" />
          </div>
          <p className="pw-text pwr-lede">Salas abertas tocando agora. Entre em uma e ouça junto.</p>
        </div>

        {!features.publicRooms ? (
          <p className="pw-plate pwr-note" role="status">
            O diretório de salas públicas não está disponível neste servidor.
          </p>
        ) : (
          <>
            <div className="pwr-toolbar">
              <div className="pwr-search">
                <label htmlFor="rooms-search" className="pw-label">Buscar por nome</label>
                <input
                  id="rooms-search"
                  type="search"
                  placeholder="Nome da sala"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="pw-input"
                />
              </div>
              <div className="pw-seg" role="group" aria-label="Ordenar por">
                <button type="button" aria-pressed={sort === 'people'} onClick={() => setSort('people')}>
                  Mais pessoas
                </button>
                <button type="button" aria-pressed={sort === 'recent'} onClick={() => setSort('recent')}>
                  Mais recentes
                </button>
              </div>
            </div>

            {!loaded ? (
              <p className="pw-plate pwr-note" role="status">Carregando salas...</p>
            ) : rooms.length === 0 ? (
              <div className="pw-plate pwr-empty" role="status">
                <span className="pwr-led">PALCO LIVRE</span>
                <p className="pwr-empty__text">
                  Nenhuma sala pública no ar agora. Crie uma e ative a opção Pública.
                </p>
                <button type="button" className="pw-btn" onClick={createRoom}>Criar sala</button>
              </div>
            ) : visible.length === 0 ? (
              <p className="pw-plate pwr-note" role="status">Nenhuma sala encontrada para essa busca.</p>
            ) : (
              <div className="pwr-rooms">
                {visible.map((room) => {
                  const live = now - room.lastActiveMs <= LIVE_WINDOW_MS && room.memberCount > 0;
                  return (
                    <div key={room.roomId} className="pwr-room-wrap">
                      <Link
                        href={`/room/${room.roomId}`}
                        className="pwr-room pw-plate"
                        aria-label={`Entrar na sala ${room.name || room.roomId}`}
                        onClick={(e) => onCardClick(e, room.roomId)}
                      >
                        <span className="pwr-room__name">{room.name || room.roomId}</span>
                        <span className="pwr-room__tags">
                          {live && (
                            <span className="r4-live pwr-live">
                              <span className="r4-live__dot" aria-hidden />
                              AO VIVO
                            </span>
                          )}
                          {room.kind === 'video' && <span className="pwr-chip">Vídeo</span>}
                        </span>
                        <span className="pwr-room__side">
                          <span className="pwr-room__count">{room.memberCount} ouvindo</span>
                          {!live && <span className="pwr-room__when">{activeLabel(room.lastActiveMs, now)}</span>}
                        </span>
                        <span className="pwr-room__track">
                          {room.nowPlaying ? (
                            <>
                              Tocando: <b>{room.nowPlaying.title}</b> · {room.nowPlaying.artist}
                            </>
                          ) : (
                            'Nada tocando ainda'
                          )}
                        </span>
                        <span className="pw-btn pw-btn--quiet pwr-room__go" aria-hidden>Entrar</span>
                      </Link>
                      {/* A sibling of the link, not a child: a button inside an anchor is
                          invalid and would also navigate. */}
                      <button
                        type="button"
                        className="pwr-report"
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
      <PalcoFooter />
    </div>
  );
}
