'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LogoMark } from '@/app/components/Logo';
import { SintoniaScreen, SineLine } from '@/app/components/SintoniaScreen';
import { generateRoomId } from '@/lib/roomId';
import { trackEvent } from '@/lib/telemetry';

// Root 404. Same ground and glass surface as the rest of the product; the wave
// lies flat because there is no signal here.
export default function NotFound() {
  const router = useRouter();
  const createRoom = () => {
    trackEvent('room_create');
    router.push(`/room/${generateRoomId()}`);
  };
  return (
    <SintoniaScreen>
      <main id="main" className="sx-main">
        <div className="sx-glass sx-card">
          <div className="sx-brand">
            <LogoMark size={20} /> CoJam
          </div>
          <p className="sx-eyebrow">Erro 404</p>
          <h1 className="sx-title">Sem sinal por aqui</h1>
          <SineLine flat />
          <p className="sx-text">Essa página não existe ou mudou de endereço. A música continua em outro lugar.</p>
          <div className="sx-actions">
            <button type="button" className="btn-primary" onClick={createRoom}>
              Criar uma sala
            </button>
            <Link href="/" className="btn-ghost">
              Voltar ao início
            </Link>
          </div>
        </div>
      </main>
    </SintoniaScreen>
  );
}
