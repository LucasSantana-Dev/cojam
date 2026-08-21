'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MINIMUM_AGE, hasAffirmedAge, affirmAge } from '@/lib/ageGate';
import type { PublicRoomSummary } from '@cojam/shared';
import { useRuntimeFeatures } from '@/lib/useRuntimeFeatures';
import { subscribePublicRooms } from '@/lib/publicRooms';

const MAX_CARDS = 5;

// LiveRoomsStrip renders real public rooms (up to 5 cards) in the .room-card
// visual language: label (host-set name or room code), live pill, now playing
// when present, listener count, and a Join link. Purely presentational; data
// fetching lives in LiveRoomsSlot + lib/publicRooms.
export function LiveRoomsStrip({ rooms }: { rooms: PublicRoomSummary[] }) {
  const router = useRouter();
  // Set to the room a visitor is trying to reach while the gate is open.
  const [pendingRoomId, setPendingRoomId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // showModal() is what makes it actually modal: it moves focus in, contains
  // Tab, makes the background inert and wires Escape. Hand-rolling a focus
  // trap to match would be strictly worse.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (pendingRoomId && !el.open) el.showModal();
    if (!pendingRoomId && el.open) el.close();
  }, [pendingRoomId]);

  // Directory joins are gated (#259); invite-link joins are untouched.
  const openRoom = (event: React.MouseEvent, roomId: string) => {
    if (hasAffirmedAge()) return; // let the Link navigate normally
    event.preventDefault();
    setPendingRoomId(roomId);
  };

  const confirmAge = () => {
    affirmAge();
    const roomId = pendingRoomId;
    setPendingRoomId(null);
    if (roomId) router.push(`/room/${roomId}`);
  };

  return (
    <div className="live-rooms">
      <span className="live-rooms__label">Live rooms</span>
      <div className="live-rooms__grid">
        {rooms.slice(0, MAX_CARDS).map((room) => (
          <Link
            key={room.roomId}
            href={`/room/${room.roomId}`}
            className="live-room-card"
            onClick={(e) => openRoom(e, room.roomId)}
          >
            <span className="live-room-card__top">
              <span className="live-room-card__name">{room.name || room.roomId}</span>
              <span className="room-card__live">
                <span className="room-card__dot" />
                Live
              </span>
            </span>
            <span className="live-room-card__track">
              {room.nowPlaying ? (
                <>
                  <span className="live-room-card__title">{room.nowPlaying.title}</span>
                  <span className="live-room-card__artist">{room.nowPlaying.artist}</span>
                </>
              ) : (
                <span className="live-room-card__artist">Nothing playing yet</span>
              )}
            </span>
            <span className="live-room-card__bottom">
              <span className="live-room-card__count">{room.memberCount} listening</span>
              <span className="live-room-card__join" aria-hidden>Join &rarr;</span>
            </span>
          </Link>
        ))}
      </div>

      {/* Rendered unconditionally so the ref exists before showModal(). The
          native element handles focus placement, containment and restoration
          to the card; onCancel covers Escape and the backdrop. */}
      <dialog
        ref={dialogRef}
        className="age-gate"
        aria-labelledby="age-gate-title"
        onCancel={(e) => {
          e.preventDefault();
          setPendingRoomId(null);
        }}
        onClose={() => setPendingRoomId(null)}
      >
        <div className="age-gate__panel">
          <h2 id="age-gate-title" className="age-gate__title">Before you join</h2>
          <p className="age-gate__body">
            Public rooms are open to people you have not met. You need to be{' '}
            {MINIMUM_AGE} or over to join one.
          </p>
          <div className="age-gate__actions">
            <button type="button" className="btn-primary" onClick={confirmAge}>
              I am {MINIMUM_AGE} or over
            </button>
            <button type="button" className="btn-ghost" onClick={() => setPendingRoomId(null)}>
              Cancel
            </button>
          </div>
        </div>
      </dialog>

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
