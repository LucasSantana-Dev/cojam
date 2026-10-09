'use client';

import { useState, useEffect, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PalcoBrand, PalcoFooter } from '@/app/components/PalcoShell';
import { PalcoScene } from '@/app/components/PalcoScene';
import { LiveRoomsSlot } from '@/app/components/LiveRoomsStrip';
import { LiveCounter } from '@/app/components/LiveCounter';
import { supabaseEnabled } from '@/lib/supabase';
import { generateRoomId } from '@/lib/roomId';
import { MINIMUM_AGE } from '@/lib/ageGate';
import { readGuestName, saveGuestName } from '@/lib/guestName';
import { trackEvent } from '@/lib/telemetry';
import { errorFixture } from '@/lib/devFixture';

// Pixel portraits (characters/NN-portrait.png, 64px, shown 1:1 so the grid holds).
const portrait = (id: number) => `/palco/characters/${String(id).padStart(2, '0')}-portrait.png`;
const STEP_FACES: Record<string, number[]> = { '01': [12], '02': [], '03': [4, 9, 11] };
const CTA_FACES = [2, 6, 3, 12];

function Faces({ ids }: { ids: number[] }) {
  if (ids.length === 0) return null;
  return (
    <span className="pwh-faces" aria-hidden="true">
      {ids.map((id) => (
        // eslint-disable-next-line @next/next/no-img-element -- 64px pixel art shown 1:1; next/image would resample it
        <img key={id} src={portrait(id)} alt="" width={64} height={64} loading="lazy" decoding="async" />
      ))}
    </span>
  );
}

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
    a: 'Hoje funcionam o YouTube e o Spotify (com Premium). YouTube Music e Tidal não são compatíveis por falta de API oficial ou de licença.',
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
  // Dev only (?fixture=error): throw after mount so error.tsx can be reviewed.
  const fixtureBoom = useSyncExternalStore(noopSubscribe, errorFixture, () => false);
  // Accounts are optional and resolved at runtime (via /env.js); the server
  // snapshot keeps SSR and the first client render in agreement.
  const accountsEnabled = useSyncExternalStore(noopSubscribe, supabaseEnabled, () => false);

  // Top of the funnel. Empty deps: once per mount, not per re-render.
  useEffect(() => {
    trackEvent('landing_view');
  }, []);

  if (fixtureBoom) throw new Error('fixture: error screen preview');

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

  // Palco on every screen (decision 13): the night of the festival as ground, the
  // published palco scene at an integer scale, plates and hard-edged buttons for the
  // interface. Plain markup, no scroll-reveal: every section is visible without JS.
  return (
    <div className="pw pwh">
      <header className="pw-bar">
        <PalcoBrand />
        <nav className="pwh-nav" aria-label="Primary">
          <a href="#how">Como funciona</a>
          <a href="#previa">Veja ao vivo</a>
          <a href="#faq">Dúvidas</a>
          <a href="https://github.com/LucasSantana-Dev/cojam" target="_blank" rel="noreferrer">
            GitHub
          </a>
          {accountsEnabled && <Link href="/account">Entrar</Link>}
        </nav>
        <button type="button" onClick={createRoom} className="pw-btn pwh-bar__cta">
          Começar uma sala
        </button>
      </header>

      <main id="main" className="pwh-main">
        <PalcoScene kind="home" hero id="previa" testId="hero-device">
          <section className="pwh-hero" aria-labelledby="hero-title">
            <div className="pwh-hero__copy pw-plate">
              <LiveCounter pill className="pwh-livecount" />
              <h1 id="hero-title" className="pw-title pwh-hero__title">
                <span className="pwh-line">Seus amigos.</span>
                <span className="pwh-line">Suas plataformas.</span>
                <span className="pwh-line">Uma sala.</span>
              </h1>
              <p className="pw-text pwh-hero__sub">
                A fila é de quem está na sala, não de um algoritmo. Cada pessoa toca na própria conta
                de streaming, e o CoJam só sincroniza os metadados.
              </p>

              <div className="pwh-create">
                <form onSubmit={createNamedRoom} className="pwh-create__form">
                  <label htmlFor="hero-name" className="pwh-label">Seu nome</label>
                  <input
                    id="hero-name"
                    type="text"
                    autoComplete="nickname"
                    maxLength={40}
                    placeholder="Digite seu nome"
                    value={nameInput}
                    onChange={(e) => setTypedName(e.target.value)}
                    className="pwh-input"
                  />
                  <button type="submit" disabled={!nameInput.trim()} className="pw-btn">
                    Criar sala
                  </button>
                </form>
                <form onSubmit={joinRoom} className="pwh-create__form pwh-create__form--join">
                  <label htmlFor="hero-room-code" className="pwh-label">Tem um código?</label>
                  <input
                    id="hero-room-code"
                    type="text"
                    placeholder="Código"
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value)}
                    className="pwh-input pwh-input--code"
                  />
                  <button type="submit" disabled={!roomId.trim()} className="pw-btn pw-btn--quiet">
                    Entrar
                  </button>
                </form>
              </div>

              <p className="pwh-claims">
                <span>Sem instalar</span>
                <span>Sem conta para convidados</span>
                <span>Grátis</span>
              </p>
            </div>
          </section>
        </PalcoScene>

        {/* The example room the scene above shows: illustrative, so it says so. */}
        <section className="pwh-now pw-plate" aria-label="Prévia ilustrativa de uma sala tocando agora">
          <p className="pwh-now__kicker">Tocando agora</p>
          <p className="pwh-now__track">
            <span className="pwh-now__title">Pétala</span>
            <span className="pwh-now__artist">Djavan</span>
          </p>
          <span className="pwh-chip pwh-now__by">Bia pediu</span>
          <div className="pwh-now__progress" aria-hidden="true">
            <span className="pwh-mono">1:24</span>
            <span className="pwh-now__bar"><span style={{ width: '40%' }} /></span>
            <span className="pwh-mono">3:34</span>
          </div>
          <p className="pwh-now__count"><b className="pwh-mono">7</b> ouvindo junto</p>
        </section>

        {/* F1: when FEATURE_PUBLIC_ROOMS is on and the directory returns live
            rooms, the slot renders the live strip; flag off, empty list or fetch
            failure renders nothing and the example room above stands alone. */}
        <LiveRoomsSlot fallback={null} />

        <section id="how" className="pwh-section" aria-labelledby="how-title">
          <h2 id="how-title" className="pw-title pwh-h2">Como funciona em 3 passos</h2>
          <ol className="pwh-steps">
            {STEPS.map((s) => (
              <li key={s.n} className="pw-plate pwh-step">
                <div className="pwh-step__head">
                  <span className="pwh-num pwh-mono" aria-hidden="true">{s.n}</span>
                  <Faces ids={STEP_FACES[s.n] ?? []} />
                </div>
                <h3 className="pwh-step__title">{s.t}</h3>
                <p className="pw-text">{s.d}</p>
                <p className="pwh-step__chips">
                  {s.chips.map((c) => <span key={c} className="pwh-chip">{c}</span>)}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <div className="pwh-lower">
          {/* FAQ: native details/summary (keyboard + a11y for free). The same
              array feeds the FAQPage JSON-LD, so markup and structured data
              cannot drift. Answers describe CoJam as it ships today. */}
          <section id="faq" className="pwh-section pwh-faq" aria-labelledby="faq-title">
            <h2 id="faq-title" className="pw-title pwh-h2">Dúvidas</h2>
            <div className="pwh-faq__list">
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

          <section className="pwh-final pw-plate" aria-labelledby="final-title">
            <div className="pwh-final__copy">
              <h2 id="final-title" className="pw-title pwh-final__title">Crie uma sala em um clique.</h2>
              <p className="pw-text">É grátis, rápido e direto no seu navegador.</p>
            </div>
            <Faces ids={CTA_FACES} />
            <button type="button" onClick={createRoom} className="pw-btn">
              Começar uma sala
            </button>
          </section>
        </div>
      </main>

      <PalcoFooter />
    </div>
  );
}
