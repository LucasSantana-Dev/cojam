'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AGE_GATE_COPY_PT, useAgeGatedJoin } from './useAgeGatedJoin';
import type { PublicRoomSummary } from '@cojam/shared';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import { subscribePublicRooms } from '@/lib/publicRooms';
import { RoomBand } from './ListenerBand';

const MAX_CARDS = 5;

// LiveRoomsStrip renders real public rooms (up to 5 cards) in the .room-card
// visual language: label (host-set name or room code), live pill, now playing
// when present, listener count, and a Join link. Purely presentational; data
// fetching lives in LiveRoomsSlot + lib/publicRooms.
export function LiveRoomsStrip({ rooms }: { rooms: PublicRoomSummary[] }) {
  const { onCardClick, gate } = useAgeGatedJoin(AGE_GATE_COPY_PT);

  return (
    <div className="live-rooms">
      <div className="live-rooms__head">
        <span className="live-rooms__label">Salas ao vivo</span>
        <Link href="/rooms" className="live-rooms__all">ver todas &rarr;</Link>
      </div>
      <div className="live-rooms__grid">
        {rooms.slice(0, MAX_CARDS).map((room) => (
          <Link
            key={room.roomId}
            href={`/room/${room.roomId}`}
            className="live-room-card"
            onClick={(e) => onCardClick(e, room.roomId)}
          >
            <span className="live-room-card__top">
              <span className="live-room-card__name">{room.name || room.roomId}</span>
              <span className="room-card__live">
                <span className="room-card__dot" />
                Ao vivo
              </span>
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
                <RoomBand count={room.memberCount} />
                {room.memberCount} ouvindo
              </span>
              <span className="live-room-card__join" aria-hidden>Entrar &rarr;</span>
            </span>
          </Link>
        ))}
      </div>

      {gate}
    </div>
  );
}

// LiveRoomsSlot owns the hero slot on the landing page: it renders the live
// strip once a non-empty directory arrives and the fallback (the static
// example-room mock) otherwise. Flag off, empty list, and fetch failure all
// render the fallback, so a deploy with zero public rooms never shows a hole.
export function LiveRoomsSlot({ fallback }: { fallback: React.ReactNode }) {
  // Resolved at runtime (via /env.js) like every other flag (RFC-0006); the
  // hook's server snapshot (build-time values) keeps SSR and the first client
  // render in agreement.
  const f = useRuntimeFeatures();
  const [rooms, setRooms] = useState<PublicRoomSummary[]>([]);

  useEffect(() => {
    if (!f.publicRooms) return;
    return subscribePublicRooms(setRooms);
  }, [f.publicRooms]);

  // Flag flipped off mid-session: fall back even if a stale list is still in
  // state (flags resolve once per session, but the guard is cheap).
  if (!f.publicRooms || rooms.length === 0) return <>{fallback}</>;
  return <LiveRoomsStrip rooms={rooms} />;
}
