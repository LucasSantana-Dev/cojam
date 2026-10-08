'use client';

import { useState, useEffect, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CheckIcon } from '@/app/components/icons';
import { LiveRoomsSlot } from '@/app/components/LiveRoomsStrip';
import { LiveCounter } from '@/app/components/LiveCounter';
import { R4Brand, R4Footer } from '@/app/components/R4Shell';
import { RoomPreview } from '@/app/components/RoomPreview';
import { supabaseEnabled } from '@/lib/supabase';
import { generateRoomId } from '@/lib/roomId';
import { MINIMUM_AGE } from '@/lib/ageGate';
import { readGuestName, saveGuestName } from '@/lib/guestName';
import { trackEvent } from '@/lib/telemetry';

const STEPS = [
  { n: '01', t: 'Digite seu nome e crie a sala', chips: ['Grátis', 'Sem cadastro'], d: 'Sem instalar nada e sem conta. A sala nasce privada: só entra quem tem o link.' },
  { n: '02', t: 'Mande o link', chips: ['Um link só', 'Onde estiverem'], d: 'Um link coloca seus amigos na mesma sala, onde estiverem. Cada um entra com o próprio nome.' },
  { n: '03', t: 'Toquem em sincronia', chips: ['Spotify', 'YouTube'], d: 'Montem a fila juntos; a sala sincroniza quem toca o quê. Cada um ouve na própria conta, no Spotify ou no YouTube.' },
];

// Runtime env (/env.js) never changes after load; nothing to subscribe to.
const noopSubscribe = () => () => {};

// Honest, current-state answers (README platform table, CONTEXT.md trust model).
// Keep this list true: no video, no screen share, no unsupported services.
const FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'O CoJam é grátis?',
    a: 'Sim, usar o CoJam não custa nada. O que continua por conta de cada pessoa é o próprio serviço de streaming: o Spotify, por exemplo, exige Premium para tocar no navegador.',
  },
  {
    q: 'Preciso criar uma conta?',
    a: 'Não. Para criar ou entrar numa sala basta digitar um nome. Nada de instalar app nem cadastrar e-mail.',
  },
  {
    q: 'Como todo mundo ouve a mesma música se cada um usa um serviço?',
    a: 'Cada pessoa toca na própria conta de streaming. O CoJam sincroniza só os metadados (a fila, quem toca o quê e em que ponto da faixa), nunca retransmite áudio. Entre serviços diferentes pode haver uma diferença de cerca de meio segundo, porque cada um usa a sua própria gravação.',
  },
  {
    q: 'Quais serviços funcionam?',
    a: 'Hoje funcionam o YouTube e o Spotify (com Premium). O Apple Music ainda está em desenvolvimento. YouTube Music e Tidal não são compatíveis por falta de API oficial ou de licença.',
  },
  {
    q: 'Funciona no celular?',
    a: 'A sala abre no navegador do celular, sem instalar nada. Como o som sai do player do próprio serviço dentro do navegador, o comportamento pode variar conforme o aparelho e o navegador.',
  },
  {
    q: 'A sala é pública ou privada?',
    a: `Toda sala nasce privada: só entra quem tem o link, e o link é a permissão. Quem cria a sala pode torná-la pública para aparecer na lista de salas ao vivo. Para entrar numa sala pública pela lista, é preciso confirmar que tem ${MINIMUM_AGE} anos ou mais.`,
  },
];

function faqJsonLd(): string {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: 'pt-BR',
    mainEntity: FAQ.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
  // Escape "<" so a future answer can never close the script tag.
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

export default function Home() {
  const [roomId, setRoomId] = useState('');
  // Name for the one-step create. Prefilled from the shared guest name (the
  // same session key the room's join form uses); null until the user types.
  const savedName = useSyncExternalStore(noopSubscribe, readGuestName, () => '');
  const [typedName, setTypedName] = useState<string | null>(null);
  const nameInput = typedName ?? savedName;
  const router = useRouter();
  // Accounts are optional and resolved at runtime (via /env.js); the server
  // snapshot keeps SSR and the first client render in agreement.
  const accountsEnabled = useSyncExternalStore(noopSubscribe, supabaseEnabled, () => false);

  // Top of the funnel. Empty deps: once per mount, not per re-render.
  useEffect(() => {
    trackEvent('landing_view');
  }, []);

  const createRoom = () => {
    trackEvent('room_create');
    router.push(`/room/${generateRoomId()}`);
  };
  // Name + create in one submit: store the name where the room page already
  // looks for it, then land in a fresh room that auto-joins with it. The room
  // is born private (the unguessable link is the permission); going public
  // stays the host's PublicRoomToggle.
  const createNamedRoom = (e: React.FormEvent) => {
    e.preventDefault();
    const name = nameInput.trim();
    if (!name) return;
    saveGuestName(name);
    trackEvent('room_create');
    router.push(`/room/${generateRoomId()}`);
  };
  const joinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomId.trim()) {
      trackEvent('room_join');
      router.push(`/room/${roomId.trim().toUpperCase()}`);
    }
  };

  // Round 4 (#325): near-black ground with violet ambient light, the room's
  // panels and type. Everything is plain markup: no scroll-reveal, so every
  // section is visible without JS or animation.
  return (
    <div className="r4s">
      <header className="r4s-bar r4s-bar--landing">
        <R4Brand tagline />
        <nav className="r4s-nav" aria-label="Primary">
          <a href="#how">Como funciona</a>
          <a href="#previa">Veja ao vivo</a>
          <a href="#faq">Dúvidas</a>
          <a href="https://github.com/LucasSantana-Dev/cojam" target="_blank" rel="noreferrer">
            GitHub
          </a>
          {accountsEnabled && <Link href="/account">Entrar</Link>}
        </nav>
        <button type="button" onClick={createRoom} className="r4s-btn r4s-btn--sm r4s-bar__cta">
          Começar uma sala
        </button>
      </header>

      <main id="main" className="r4s-main r4s-main--landing">
        <section className="r4s-hero" aria-labelledby="hero-title">
          <div className="r4s-hero__copy">
            <h1 id="hero-title" className="r4s-hero__title">
              <span className="r4s-line">Seus amigos.</span>
              <span className="r4s-line">Suas plataformas.</span>
              <span className="r4s-line">
                Uma <span className="r4s-accent">sala</span>.
              </span>
            </h1>
            <p className="r4s-lede r4s-hero__sub">
              A fila é de quem está na sala, não de um algoritmo. Cada pessoa toca na própria conta
              de streaming, e o CoJam só sincroniza os metadados.
            </p>

            <div className="r4s-create r4s-glow">
              <form onSubmit={createNamedRoom} className="r4s-create__form">
                <label htmlFor="hero-name" className="r4s-label">Seu nome</label>
                <input
                  id="hero-name"
                  type="text"
                  autoComplete="nickname"
                  maxLength={40}
                  placeholder="Digite seu nome"
                  value={nameInput}
                  onChange={(e) => setTypedName(e.target.value)}
                  className="r4s-input"
                />
                <button type="submit" disabled={!nameInput.trim()} className="r4s-btn">
                  Criar sala
                </button>
              </form>
              <form onSubmit={joinRoom} className="r4s-create__form r4s-create__form--join">
                <label htmlFor="hero-room-code" className="r4s-label">Tem um código?</label>
                <input
                  id="hero-room-code"
                  type="text"
                  placeholder="Código"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                  className="r4s-input r4s-input--code"
                />
                <button type="submit" disabled={!roomId.trim()} className="r4s-btn r4s-btn--quiet">
                  Entrar
                </button>
              </form>
            </div>

            <LiveCounter pill className="r4s-livecount" />

            <p className="r4s-claims">
              <span><CheckIcon size={13} /> Sem instalar</span>
              <span><CheckIcon size={13} /> Sem conta para convidados</span>
              <span><CheckIcon size={13} /> Grátis</span>
            </p>
          </div>

          <div className="r4s-hero__side" data-testid="hero-device">
            <RoomPreview />
          </div>
        </section>

        {/* F1: when FEATURE_PUBLIC_ROOMS is on and the directory returns live
            rooms, the slot renders the live strip; flag off, empty list or fetch
            failure renders nothing and the example room above stands alone. */}
        <LiveRoomsSlot fallback={null} />

        <section id="how" className="r4s-section" aria-labelledby="how-title">
          <h2 id="how-title" className="r4s-h2 r4s-h2--grad">Como funciona em 3 passos</h2>
          <ol className="r4s-steps">
            {STEPS.map((s) => (
              <li key={s.n} className="r4s-card r4s-step">
                <h3 className="r4s-step__title"><span>{s.n} /</span> {s.t}</h3>
                <p>{s.d}</p>
                <p className="r4s-step__chips">
                  {s.chips.map((c) => <span key={c} className="r4s-chip">{c}</span>)}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <div className="r4s-lower">
          {/* FAQ: native details/summary (keyboard + a11y for free). The same
              array feeds the FAQPage JSON-LD, so markup and structured data
              cannot drift. Answers describe CoJam as it ships today. */}
          <section id="faq" className="r4s-section r4s-faq" aria-labelledby="faq-title">
            <h2 id="faq-title" className="r4s-h2">Dúvidas</h2>
            <div className="r4s-faq__list">
              {FAQ.map((item) => (
                <details key={item.q} className="faq-item">
                  <summary>{item.q}</summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
            <script
              type="application/ld+json"
              dangerouslySetInnerHTML={{ __html: faqJsonLd() }}
            />
          </section>

          <section className="r4s-final r4s-glow" aria-labelledby="final-title">
            <h2 id="final-title" className="r4s-final__title">Crie uma sala em um clique.</h2>
            <button type="button" onClick={createRoom} className="r4s-btn">
              Começar uma sala
            </button>
            <p className="r4s-final__note">É grátis, rápido e direto no seu navegador.</p>
          </section>
        </div>
      </main>

      <R4Footer />
    </div>
  );
}
