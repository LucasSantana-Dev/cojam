'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PalcoBrandBar } from '@/app/components/PalcoShell';
import { PalcoScene } from '@/app/components/PalcoScene';
import { generateRoomId } from '@/lib/roomId';
import { trackEvent } from '@/lib/telemetry';

// Root 404. Palco screen: the stage screen reads "404 SEM SINAL", the crowd is
// gone and only you are left on the floor.
export default function NotFound() {
  const router = useRouter();
  const createRoom = () => {
    trackEvent('room_create');
    router.push(`/room/${generateRoomId()}`);
  };
  return (
    <div className="pw">
      <PalcoBrandBar />
      <PalcoScene kind="404">
        <main id="main" className="pw-dock pw-plate">
          <div className="pw-dock__copy">
            <p className="pw-eyebrow">Erro 404 · sem sinal</p>
            <h1 className="pw-title">Esse palco não existe</h1>
            <p className="pw-text">
              O endereço mudou ou a sala acabou. A música continua em outro lugar.
            </p>
          </div>
          <div className="pw-actions">
            <Link href="/" className="pw-btn pw-btn--quiet">
              Voltar ao início
            </Link>
            <Link href="/rooms" className="pw-btn pw-btn--quiet">
              Ver salas ao vivo
            </Link>
            <button type="button" className="pw-btn" onClick={createRoom}>
              Criar uma sala
            </button>
          </div>
        </main>
      </PalcoScene>
    </div>
  );
}
