'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { generateRoomId } from '@/lib/roomId';
import { trackEvent } from '@/lib/telemetry';

// "Criar sala" as on the home and the 404: a fresh room code, straight into the room.
export function useCreateRoom(): () => void {
  const router = useRouter();
  return () => {
    trackEvent('room_create');
    router.push(`/room/${generateRoomId()}`);
  };
}

function CreateRoomButton() {
  const createRoom = useCreateRoom();
  return (
    <button type="button" className="pw-btn" onClick={createRoom}>
      Criar sala
    </button>
  );
}

// The top-bar actions of the wave 2 screens, over the scene: "Salas ao vivo" (from 48rem)
// and the violet "Criar sala". Each screen picks the pieces it needs.
export function PalcoNav({
  rooms = true,
  create = false,
  current,
}: {
  rooms?: boolean;
  create?: boolean;
  current?: 'rooms';
}) {
  return (
    <nav className="pw-nav" aria-label="Navegação">
      {rooms && (
        <Link href="/rooms" className="pw-nav__link" aria-current={current === 'rooms' ? 'page' : undefined}>
          Salas ao vivo
        </Link>
      )}
      {create && <CreateRoomButton />}
    </nav>
  );
}
