// Landing hero device (#325): a live room painted in the colour of the track on
// stage. Decorative and fictional (hidden from assistive tech); the colour is the
// same mechanism the real room uses, so the page shows what the product does.
import { DEMO_TRACKS } from '@/lib/demoTracks';
import { ListenersWave } from './ListenersWave';

const DEMO_LISTENERS = [
  { id: 'Lucas', name: 'Lucas' },
  { id: 'Bia', name: 'Bia' },
  { id: 'Caio', name: 'Caio' },
];

const CHAT = [
  { who: 'Bia', text: 'essa bateu forte demais', hearts: 12 },
  { who: 'Caio', text: 'sobe o volume!!', hearts: 7 },
  { who: 'Lucas', text: 'a próxima é pedido da Bia', hearts: 4 },
];

function Heart() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 20.5C6 16.3 3 13.2 3 9.5 3 7 4.9 5 7.4 5c1.8 0 3.4 1 4.6 2.6C13.2 6 14.8 5 16.6 5 19.1 5 21 7 21 9.5c0 3.7-3 6.8-9 11z" />
    </svg>
  );
}

export function HeroDevice({ index, waveAnimate = false, testId }: { index: number; waveAnimate?: boolean; testId?: string }) {
  const track = DEMO_TRACKS[index % DEMO_TRACKS.length];
  return (
    <div className="hero-device" data-testid={testId} aria-hidden="true">
      <div className="hero-device__body">
        <div className="dev-room">
          <div className="dev-top">
            <span className="room-card__live"><span className="room-card__dot" />Ao vivo</span>
            <span className="dev-listeners">
              <i style={{ background: 'var(--color-ident-1)' }}>L</i>
              <i style={{ background: 'var(--color-ident-2)' }}>B</i>
              <i style={{ background: 'var(--color-ident-3)' }}>C</i>
              <b>3 ouvindo</b>
            </span>
          </div>
          <div className="dev-stage">
            <div className="dev-cover" />
            <div className="dev-meta">
              <p className="dev-title" key={track.title}>{track.title}</p>
              <p className="dev-artist">{track.artist}</p>
              <div className="dev-progress"><span /></div>
            </div>
          </div>
          <ListenersWave members={DEMO_LISTENERS} running animate={waveAnimate} className="dev-wave" />
          <ul className="dev-chat">
            {CHAT.map((m) => (
              <li key={m.who}>
                <b>{m.who}</b>
                <span>{m.text}</span>
                <em><Heart />{m.hearts}</em>
              </li>
            ))}
          </ul>
          <div className="dev-input">Mensagem</div>
        </div>
      </div>
    </div>
  );
}
