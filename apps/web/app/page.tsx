'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { SpotifyIcon, YouTubeIcon, AppleMusicIcon } from '@/app/components/icons';
import { RoomShowcase } from '@/app/components/RoomShowcase';

const HeroCanvas = dynamic(() => import('@/app/components/HeroCanvas'), {
  ssr: false,
  loading: () => null,
});

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Split a headline into per-word spans wrapped in overflow:hidden masks for reveal animation.
function Words({ text, start = 0 }: { text: string; start?: number }) {
  return (
    <>
      {text.split(' ').map((w, i) => (
        <span key={`${w}-${i}`} className="word-mask" style={{ ['--i' as string]: start + i }}>
          <span className="word">{w}</span>
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

    // Dynamic import GSAP only client-side, after window is defined.
    const initGsap = async () => {
      try {
        const gsap = await import('gsap');
        const ScrollTrigger = (await import('gsap/ScrollTrigger')).default;
        gsap.default.registerPlugin(ScrollTrigger);

        const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

        // Use gsap.context for scoped cleanup.
        const ctx = gsap.default.context(() => {
          // Replace the IO-based reveals with GSAP ScrollTrigger: stagger section cards.
          const revealElements = root.querySelectorAll('.reveal');

          // Stagger group: step-cards have a 40ms stagger between each.
          const stepCards = root.querySelectorAll('.step-card.reveal');
          if (stepCards.length > 0) {
            gsap.default.fromTo(
              stepCards,
              { opacity: 0, y: 28 },
              {
                opacity: 1,
                y: 0,
                duration: 0.7,
                stagger: 0.05,
                ease: 'cubic-bezier(0.2, 0.65, 0.2, 1)',
                scrollTrigger: {
                  trigger: stepCards[0],
                  start: 'top center+=100',
                  end: 'center center',
                  toggleActions: 'play none none none',
                  markers: false,
                },
              },
            );
          }

          // Individual reveals (section titles, eyebrows, platform row, final CTA).
          revealElements.forEach((el) => {
            // Skip step-cards (already animated above).
            if (el.classList.contains('step-card')) return;

            gsap.default.fromTo(
              el,
              { opacity: 0, y: 28 },
              {
                opacity: 1,
                y: 0,
                duration: 0.7,
                ease: 'cubic-bezier(0.2, 0.65, 0.2, 1)',
                scrollTrigger: {
                  trigger: el,
                  start: 'top center+=100',
                  end: 'center center',
                  toggleActions: 'play none none none',
                  markers: false,
                },
              },
            );
          });

          // Scroll scrub: RoomShowcase progress bar animates as user scrolls through showcase.
          // One subtle, scrubbed beat: progress bar fills from 35% to 90% over the showcase scroll.
          if (!prefersReduced) {
            const showcase = root.querySelector<HTMLElement>('.room-showcase');
            if (showcase) {
              gsap.default.to(showcase, {
                '--progress': '90%' as any,
                scrollTrigger: {
                  trigger: showcase,
                  start: 'top center+=100',
                  end: 'bottom center',
                  scrub: 1.2,
                  markers: false,
                },
              });
            }
          }

          // Scroll parallax: multi-layer depth for hero + sections (compositor-safe, vestibular-safe).
          if (!prefersReduced) {
            // Hero aurora: slower parallax (background layer, farther away).
            const heroAurora = root.querySelector<HTMLElement>('.hero-aurora');
            if (heroAurora) {
              gsap.default.to(heroAurora, {
                y: -30,
                scrollTrigger: {
                  trigger: root.querySelector('.hero'),
                  start: 'top top',
                  end: 'bottom top',
                  scrub: 0.8,
                  markers: false,
                },
              });
            }

            // Hero glow: medium parallax (midground, interactive element).
            const heroGlow = root.querySelector<HTMLElement>('.hero-glow');
            if (heroGlow) {
              gsap.default.to(heroGlow, {
                y: -60,
                scrollTrigger: {
                  trigger: root.querySelector('.hero'),
                  start: 'top top',
                  end: 'bottom top',
                  scrub: 1,
                  markers: false,
                },
              });
            }

            // Sections: staggered parallax for depth perception.
            const sections = root.querySelectorAll('.section');
            sections.forEach((section, i) => {
              gsap.default.to(section, {
                y: (i + 1) * -35,
                scrollTrigger: {
                  trigger: section,
                  start: 'top 85%',
                  end: 'bottom 15%',
                  scrub: 1,
                  markers: false,
                },
              });
            });
          }
        }, root);

        cleanups.push(() => ctx.revert());
      } catch (error) {
        console.error('GSAP initialization failed:', error);
      }
    };

    initGsap();

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

    // Scroll-driven: hide/reveal sticky header by scroll direction. rAF-throttled; transform/opacity only.
    // (Hero parallax is now handled by GSAP ScrollTrigger for smoother, coordinated depth layering.)
    const header = root.querySelector<HTMLElement>('.site-header');
    let lastY = window.scrollY;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        if (header) {
          // Reveal near the top; otherwise hide when scrolling down.
          header.classList.toggle('hidden', y > lastY && y > 120);
        }
        lastY = y;
        ticking = false;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    cleanups.push(() => window.removeEventListener('scroll', onScroll));

    return () => cleanups.forEach((fn) => fn());
  }, []);

  const steps = [
    { n: '01', t: 'Everyone brings their own', d: 'Spotify, YouTube, or Apple Music. No one switches services or shares a login.' },
    { n: '02', t: 'Share the room link', d: 'One link drops your friends into the same room, wherever they are.' },
    { n: '03', t: 'Play in sync', d: 'Queue tracks together; the room syncs who plays what. Each of you streams on your own account.' },
  ];

  const platformIcons: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
    'YouTube': YouTubeIcon,
    'Spotify': SpotifyIcon,
    'Apple Music': AppleMusicIcon,
  };

  const platforms: Array<[string, boolean]> = [
    ['YouTube', true],
    ['Spotify', true],
    ['Apple Music', false],
  ];

  return (
    <div ref={rootRef} className="landing">
      <header className="site-header">
        <span className="brand">Cojam</span>
        <button onClick={createRoom} className="btn-primary magnetic">
          Start a room
        </button>
      </header>
      <main id="main" className="landing-content">
        {/* Hero */}
        <header className="hero">
          <Suspense fallback={null}>
            <HeroCanvas />
          </Suspense>
          <div className="hero-aurora" aria-hidden />
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
              <Words text="One" start={4} />
              {/* Signature payoff word: italic + brighter glow, wrapped in mask. */}
              <span className="word-mask word-accent" style={{ ['--i' as string]: 5 }}>
                <span className="word">room.</span>
              </span>
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

        {/* Room Showcase */}
        <section className="section">
          <p className="section-eyebrow reveal">In the room right now</p>
          <h2 className="section-title reveal">See it in sync.</h2>
          <p className="max-w-2xl mx-auto text-center reveal" style={{ color: 'var(--color-text-secondary)', marginBottom: '2.5rem' }}>
            Watch how Cojam keeps everyone's queue in perfect sync while each person plays on their own service.
          </p>
          <RoomShowcase />
        </section>

        {/* Platforms */}
        <section className="section" style={{ textAlign: 'center' }}>
          <p className="section-eyebrow reveal">Works with</p>
          <h2 className="section-title reveal">Bring the service you already pay for.</h2>
          <div className="platform-row reveal">
            {platforms.map(([name, live]) => {
              const Icon = platformIcons[name];
              return (
                <span key={name} className="platform-chip inline-flex items-center gap-2" data-live={live ? '1' : '0'}>
                  <Icon size={16} />
                  {name}
                </span>
              );
            })}
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
      </main>

      <footer className="landing-footer">
        Built in public ·{' '}
        <a href="https://github.com/LucasSantana-Dev/cojam" target="_blank" rel="noreferrer">
          github.com/LucasSantana-Dev/cojam
        </a>
      </footer>
    </div>
  );
}
