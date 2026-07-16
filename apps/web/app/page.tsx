'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Split a headline into per-word spans so CSS can stagger their entrance.
function Words({ text, start = 0 }: { text: string; start?: number }) {
  return (
    <>
      {text.split(' ').map((w, i) => (
        <span key={`${w}-${i}`} className="word" style={{ ['--i' as string]: start + i }}>
          {w}
        </span>
      ))}
    </>
  );
}

export default function Home() {
  const [roomId, setRoomId] = useState('');
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);

  const createRoom = () => router.push(`/room/${generateRoomId()}`);
  const joinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomId.trim()) router.push(`/room/${roomId.trim().toUpperCase()}`);
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const cleanups: Array<() => void> = [];

    // Scroll reveal — add `.in` once each element enters the viewport.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.15 },
    );
    root.querySelectorAll('.reveal').forEach((el) => io.observe(el));
    cleanups.push(() => io.disconnect());

    // Magnetic buttons — pointer devices only (touch skips it entirely).
    const mq = window.matchMedia('(hover: hover) and (pointer: fine)');
    if (mq.matches) {
      root.querySelectorAll<HTMLElement>('.magnetic').forEach((el) => {
        const onMove = (ev: PointerEvent) => {
          const r = el.getBoundingClientRect();
          el.style.setProperty('--mx', `${(ev.clientX - (r.left + r.width / 2)) * 0.25}px`);
          el.style.setProperty('--my', `${(ev.clientY - (r.top + r.height / 2)) * 0.4}px`);
        };
        const reset = () => {
          el.style.setProperty('--mx', '0px');
          el.style.setProperty('--my', '0px');
        };
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerleave', reset);
        cleanups.push(() => {
          el.removeEventListener('pointermove', onMove);
          el.removeEventListener('pointerleave', reset);
        });
      });
    }

    return () => cleanups.forEach((fn) => fn());
  }, []);

  const steps = [
    { n: '01', t: 'Everyone brings their own', d: 'Spotify, YouTube, or Apple Music. No one switches services or shares a login.' },
    { n: '02', t: 'Share the room link', d: 'One link drops your friends into the same room, wherever they are.' },
    { n: '03', t: 'Play in sync', d: 'Queue tracks together; the room syncs who plays what. Each of you streams on your own account.' },
  ];

  const platforms: Array<[string, boolean]> = [
    ['YouTube', true],
    ['Spotify', true],
    ['Apple Music', false],
    ['Tidal · soon', false],
  ];

  return (
    <div ref={rootRef} className="landing">
      <div className="landing-content">
        {/* Hero */}
        <header className="hero">
          <div className="hero-glow" aria-hidden />
          <div className="hero-grid" aria-hidden />
          <div className="hero-inner">
            <span className="eyebrow">
              <span className="eyebrow-dot" aria-hidden />
              Listen together, across services
            </span>
            <h1 className="hero-title">
              <Words text="Your friends." start={0} />
              <br />
              <Words text="Your platforms." start={2} />
              <br />
              <Words text="One room." start={4} />
            </h1>
            <p className="hero-sub">
              Cojam keeps a shared queue in sync while everyone plays on their own streaming
              account. Per-user streams, metadata only, never a rebroadcast.
            </p>
            <div className="hero-cta">
              <button onClick={createRoom} className="btn-primary magnetic">
                Start a room
              </button>
              <form onSubmit={joinRoom} style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="text"
                  placeholder="Room code"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                  aria-label="Room code"
                  style={{ width: '9rem', textAlign: 'center', textTransform: 'uppercase' }}
                />
                <button type="submit" disabled={!roomId.trim()} className="btn-ghost">
                  Join
                </button>
              </form>
            </div>
          </div>
        </header>

        {/* How it works */}
        <section className="section">
          <p className="section-eyebrow reveal">How it works</p>
          <h2 className="section-title reveal">One room, three streaming services, zero switching.</h2>
          <div className="step-grid">
            {steps.map((s) => (
              <div key={s.n} className="step-card reveal">
                <span className="step-num">{s.n}</span>
                <h3>{s.t}</h3>
                <p>{s.d}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Platforms */}
        <section className="section" style={{ textAlign: 'center' }}>
          <p className="section-eyebrow reveal">Works with</p>
          <h2 className="section-title reveal">Bring the service you already pay for.</h2>
          <div className="platform-row reveal">
            {platforms.map(([name, live]) => (
              <span key={name} className="platform-chip" data-live={live ? '1' : '0'}>
                {name}
              </span>
            ))}
          </div>
        </section>

        {/* Final CTA */}
        <section className="final-cta">
          <h2 className="section-title reveal" style={{ marginBottom: '1.5rem' }}>
            Start a room in one click.
          </h2>
          <button onClick={createRoom} className="btn-primary magnetic reveal">
            Start a room
          </button>
        </section>

        <footer className="landing-footer">
          Built in public ·{' '}
          <a href="https://github.com/LucasSantana-Dev/cojam" target="_blank" rel="noreferrer">
            github.com/LucasSantana-Dev/cojam
          </a>
        </footer>
      </div>
    </div>
  );
}
