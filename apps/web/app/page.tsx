'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SpotifyIcon, YouTubeIcon, CheckIcon } from '@/app/components/icons';
import { RoomShowcase } from '@/app/components/RoomShowcase';
import { LogoMark } from '@/app/components/Logo';
import { supabaseEnabled } from '@/lib/supabase';


function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Protocol commands cycled in the HUD readout. The product is a protocol
// (RoomState, RPC dispatch, version bumps) — this is its voice.
const HUD_COMMANDS = [';sync', ';queue', ';veto'];

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
  // Accounts are optional and resolved at runtime (via /env.js); resolve after
  // mount to avoid an SSR hydration mismatch.
  const [accountsEnabled, setAccountsEnabled] = useState(false);
  useEffect(() => {
    setAccountsEnabled(supabaseEnabled());
  }, []);

  const createRoom = () => router.push(`/room/${generateRoomId()}`);
  const joinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomId.trim()) router.push(`/room/${roomId.trim().toUpperCase()}`);
  };

  // HUD readouts (hunt-2: the landing behaves like a room). A real session
  // clock (honest time — never a fabricated room count) and a rotating
  // protocol command. Both tick only when motion is allowed.
  const [clock, setClock] = useState('00:00');
  const [cmdIndex, setCmdIndex] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t0 = Date.now();
    const clockId = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      setClock(`${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
    }, 1000);
    const cmdId = setInterval(() => setCmdIndex((i) => (i + 1) % HUD_COMMANDS.length), 2200);
    return () => {
      clearInterval(clockId);
      clearInterval(cmdId);
    };
  }, []);

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
          // Gated on reduced-motion — under reduce, the CSS `.reveal` rule shows
          // them statically (no slide), per prefers-reduced-motion guidance.
          const stepCards = root.querySelectorAll('.step-card.reveal');
          if (stepCards.length > 0 && !prefersReduced) {
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

          // Platform chips: stagger in individually (springy) instead of the whole
          // row appearing as one flat block — the one spot that read less crafted.
          const chips = root.querySelectorAll('.platform-chip');
          if (chips.length > 0 && !prefersReduced) {
            gsap.default.fromTo(
              chips,
              { opacity: 0, y: 20, scale: 0.94 },
              {
                opacity: 1,
                y: 0,
                scale: 1,
                duration: 0.6,
                stagger: 0.08,
                ease: 'back.out(1.6)',
                scrollTrigger: {
                  trigger: root.querySelector('.platform-row'),
                  start: 'top center+=120',
                  toggleActions: 'play none none none',
                  markers: false,
                },
              },
            );
          }

          // Hunt-2 "the landing is a room": backdrop word repeats sway at their
          // fixed angles; the example room card floats. CSS vars carry the
          // motion so the CSS rotate/tilt survives (GSAP writes inline transform).
          if (!prefersReduced) {
            const swayA = root.querySelector<HTMLElement>('.hero-backdrop-word--a');
            if (swayA) {
              gsap.default.to(swayA, {
                '--sway': '18px',
                duration: 9,
                yoyo: true,
                repeat: -1,
                ease: 'sine.inOut',
              });
            }
            const swayB = root.querySelector<HTMLElement>('.hero-backdrop-word--b');
            if (swayB) {
              gsap.default.to(swayB, {
                '--sway': '-16px',
                duration: 12,
                yoyo: true,
                repeat: -1,
                ease: 'sine.inOut',
              });
            }
            const roomCard = root.querySelector<HTMLElement>('.room-card');
            if (roomCard) {
              gsap.default.to(roomCard, {
                '--float': '-10px',
                duration: 3.4,
                yoyo: true,
                repeat: -1,
                ease: 'sine.inOut',
              });
            }
          }

          // ---- Modern motion pack (created top-to-bottom in page order; all
          // gated on reduced-motion, compositor-safe transform/opacity) ----
          if (!prefersReduced) {
            // 1. Scroll progress rail: the page's own instrument readout.
            const railBar = root.querySelector<HTMLElement>('.scroll-rail__bar');
            if (railBar) {
              gsap.default.to(railBar, {
                scaleX: 1,
                ease: 'none',
                scrollTrigger: { start: 0, end: 'max', scrub: 0.3, markers: false },
              });
            }

            // 2. Hero exit: content drifts up and recedes as you scroll away;
            // the giant backdrop word sinks slower, for depth.
            const heroEl = root.querySelector<HTMLElement>('.hero');
            const heroInner = root.querySelector<HTMLElement>('.hero-inner');
            if (heroEl && heroInner) {
              gsap.default.to(heroInner, {
                y: -70,
                opacity: 0.25,
                ease: 'none',
                scrollTrigger: {
                  trigger: heroEl,
                  start: 'top top',
                  end: 'bottom top',
                  scrub: true,
                  markers: false,
                },
              });
            }
            const backdropWord = root.querySelector<HTMLElement>('.hero-backdrop-word:not(.hero-backdrop-word--a):not(.hero-backdrop-word--b)');
            if (heroEl && backdropWord) {
              gsap.default.to(backdropWord, {
                y: 90,
                ease: 'none',
                scrollTrigger: {
                  trigger: heroEl,
                  start: 'top top',
                  end: 'bottom top',
                  scrub: true,
                  markers: false,
                },
              });
            }

            // 3. Velocity-reactive marquee: GSAP takes over from the CSS loop
            // so the ticker surges while scrolling and settles back when idle.
            // (CSS animation stays as the no-GSAP fallback; disabled inline here.)
            const tickerTrack = root.querySelector<HTMLElement>('.hero-ticker__track');
            if (tickerTrack) {
              tickerTrack.style.animation = 'none';
              const marquee = gsap.default.to(tickerTrack, {
                xPercent: -50,
                duration: 36,
                ease: 'none',
                repeat: -1,
              });
              let speedTarget = 1;
              ScrollTrigger.create({
                start: 0,
                end: 'max',
                onUpdate: (self) => {
                  speedTarget = 1 + Math.min(Math.abs(self.getVelocity()) / 250, 3.5);
                },
              });
              const speedTick = () => {
                marquee.timeScale(marquee.timeScale() + (speedTarget - marquee.timeScale()) * 0.08);
                speedTarget += (1 - speedTarget) * 0.05;
              };
              gsap.default.ticker.add(speedTick);
              cleanups.push(() => gsap.default.ticker.remove(speedTick));
            }

            // 4. Spec rules draw in across the step modules, staggered.
            const stepRules = root.querySelectorAll('.step-rule');
            if (stepRules.length > 0) {
              gsap.default.to(stepRules, {
                scaleX: 1,
                duration: 0.7,
                stagger: 0.12,
                ease: 'power3.out',
                scrollTrigger: {
                  trigger: root.querySelector('.step-grid'),
                  start: 'top center+=100',
                  toggleActions: 'play none none none',
                  markers: false,
                },
              });
            }

            // 5. Showcase card tilts in on approach (perspective set in CSS).
            const tiltCard = root.querySelector<HTMLElement>('.showcase-tilt');
            if (tiltCard) {
              gsap.default.fromTo(
                tiltCard,
                { rotateX: 9, transformOrigin: 'center top' },
                {
                  rotateX: 0,
                  duration: 1,
                  ease: 'power2.out',
                  scrollTrigger: {
                    trigger: root.querySelector('.room-showcase'),
                    start: 'top center+=120',
                    toggleActions: 'play none none none',
                    markers: false,
                  },
                },
              );
            }

            // 6. Comparison rows cascade (opacity only: transforms on table
            // rows are unreliable in some engines).
            const vsRows = root.querySelectorAll('.vs-table tbody tr');
            if (vsRows.length > 0) {
              gsap.default.fromTo(
                vsRows,
                { opacity: 0 },
                {
                  opacity: 1,
                  duration: 0.5,
                  stagger: 0.07,
                  ease: 'power2.out',
                  scrollTrigger: {
                    trigger: root.querySelector('.vs-table'),
                    start: 'top center+=100',
                    toggleActions: 'play none none none',
                    markers: false,
                  },
                },
              );
            }
          }

          // Individual reveals (section titles, eyebrows, platform row, final CTA).
          // Gated on reduced-motion — under reduce, the CSS `.reveal` rule shows
          // them statically instead of sliding up.
          if (!prefersReduced) {
            revealElements.forEach((el) => {
              // Skip step-cards + platform chips (already animated above).
              if (el.classList.contains('step-card') || el.classList.contains('platform-chip')) return;

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
          }

          // Scroll scrub: RoomShowcase progress bar animates as user scrolls through showcase.
          // One subtle, scrubbed beat: progress bar fills from 35% to 90% over the showcase scroll.
          if (!prefersReduced) {
            const showcase = root.querySelector<HTMLElement>('.room-showcase');
            if (showcase) {
              gsap.default.to(showcase, {
                '--progress': '90%',
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

        // Web fonts (next/font) load after this init, and their metrics reflow
        // the hero + sections — recomputing every ScrollTrigger's start/end so
        // reveals don't fire against the fallback-font layout. Official GSAP
        // guidance: refresh after fonts are ready.
        if (typeof document !== 'undefined' && document.fonts?.ready) {
          document.fonts.ready.then(() => ScrollTrigger.refresh()).catch(() => {});
        }
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
    { n: '01', t: 'Everyone brings their own', d: 'Spotify or YouTube. No one switches services or shares a login.' },
    { n: '02', t: 'Share the room link', d: 'One link drops your friends into the same room, wherever they are.' },
    { n: '03', t: 'Play in sync', d: 'Queue tracks together; the room syncs who plays what. Each of you streams on your own account.' },
  ];

  // Evergreen value phrases for the hero marquee. Decorative (the parent is
  // aria-hidden); the same claims appear in the readable sections below.
  const tickerPhrases = [
    'Per-user streams',
    'Metadata only, never a rebroadcast',
    'Everyone on their own account',
    'The queue stays in sync',
    'Bring the service you already pay for',
  ].map((phrase, i) => (
    <span key={i} className="ticker-item">
      {phrase}
      <b>·</b>
    </span>
  ));

  const platformIcons: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
    'YouTube': YouTubeIcon,
    'Spotify': SpotifyIcon,
  };

  const platforms: Array<[string, boolean]> = [
    ['YouTube', true],
    ['Spotify', true],
  ];

  return (
    <div ref={rootRef} className="landing">
      {/* Scroll progress rail: the page's own instrument readout. */}
      <div className="scroll-rail" aria-hidden><div className="scroll-rail__bar" /></div>
      <header className="site-header">
        <span className="brand"><LogoMark size={18} /> CoJam</span>
        <nav className="site-nav" aria-label="Primary">
          <a href="#how">How it works</a>
          <a href="#showcase">See it live</a>
          <a href="https://github.com/LucasSantana-Dev/cojam" target="_blank" rel="noreferrer">
            GitHub
          </a>
          {accountsEnabled && <Link href="/account">Sign in</Link>}
        </nav>
        <button onClick={createRoom} className="btn-primary magnetic">
          Start a room
        </button>
      </header>
      <main id="main" className="landing-content">
        {/* Hero */}
        <header className="hero">
          <div className="hero-aurora" aria-hidden />
          <div className="hero-glow" aria-hidden />
          <div className="hero-grid" aria-hidden />
          <p className="hero-backdrop-word" aria-hidden>together</p>
          <p className="hero-backdrop-word hero-backdrop-word--a" aria-hidden>together</p>
          <p className="hero-backdrop-word hero-backdrop-word--b" aria-hidden>together</p>

          {/* HUD corner readouts: the landing reports state like a room does.
              Honest signals only — a real session clock and the protocol's own
              command vocabulary; never a fabricated room count. Decorative. */}
          <div className="hero-hud hero-hud--tl" aria-hidden>
            <span className="hud-label">CMD</span>
            <span className="cmd-readout">{HUD_COMMANDS[cmdIndex]}</span>
          </div>
          <div className="hero-hud hero-hud--tr" aria-hidden>
            <span className="hud-label">SESSION</span>
            <span className="hud-clock">{clock}</span>
          </div>
          <div className="hero-inner">
            <span className="eyebrow is-live">
              <span className="eyebrow-dot" aria-hidden />
              Live sync, across services
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
              CoJam keeps a shared queue in sync while everyone plays on their own streaming
              account. Per-user streams, metadata only, never a rebroadcast.
            </p>
            <div className="hero-cta">
              <button onClick={createRoom} className="btn-primary magnetic">
                Start a room
              </button>
              <form onSubmit={joinRoom} className="hero-join">
                <label htmlFor="hero-room-code" className="hero-join__label">
                  Have a code?
                </label>
                <input
                  id="hero-room-code"
                  type="text"
                  placeholder="Room code"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value)}
                  style={{ width: '8rem', textAlign: 'center', textTransform: 'uppercase' }}
                />
                <button type="submit" disabled={!roomId.trim()} className="btn-ghost">
                  Join
                </button>
              </form>
            </div>

            {/* Example room artifact — evidence, not promise (Stationhead
                steal). Labeled as an example; same people/track as the
                RoomShowcase below, one consistent story. Decorative
                illustration, hidden from assistive tech. */}
            <aside className="room-card" aria-hidden="true">
              <div className="room-card__top">
                <span className="room-card__label">Example room · NEON-4821</span>
                <span className="room-card__live">
                  <span className="room-card__dot" />
                  Live
                </span>
              </div>
              <div className="room-card__main">
                <img
                  src="https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/e8/43/5f/e8435ffa-b6b9-b171-40ab-4ff3959ab661/886443919266.jpg/600x600bb.jpg"
                  alt=""
                  className="room-card__art"
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                />
                <div className="room-card__meta">
                  <span className="room-card__title">Instant Crush</span>
                  <span className="room-card__artist">Daft Punk &amp; Julian Casablancas</span>
                </div>
                <div className="eq">
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              </div>
              <div className="room-card__bottom">
                <span className="room-card__avatars">
                  <i style={{ background: '#a06bff' }}>L</i>
                  <i style={{ background: '#60a5fa' }}>M</i>
                  <i style={{ background: '#34d399' }}>T</i>
                </span>
                <span className="room-card__chat">
                  <b>Maria</b> added Borderline to the queue
                </span>
              </div>
            </aside>

            <div className="hero-claims">
              <span className="claim"><CheckIcon size={13} /> No install</span>
              <span className="claim"><CheckIcon size={13} /> No account for guests</span>
              <span className="claim"><CheckIcon size={13} /> Free</span>
              <span className="claim-sep" aria-hidden />
              <span className="claim"><SpotifyIcon size={13} /> Spotify</span>
              <span className="claim"><YouTubeIcon size={13} /> YouTube</span>
            </div>
            <nav className="hero-manifest" aria-label="Page sections">
              <a href="#how">how</a>
              <a href="#showcase">live</a>
              <a href="#vs">vs</a>
              <a href="#platforms">platforms</a>
            </nav>
          </div>
          <div className="hero-ticker" aria-hidden>
            <div className="hero-ticker__track">
              <span>{tickerPhrases}</span>
              <span>{tickerPhrases}</span>
            </div>
          </div>
        </header>

        {/* How it works */}
        <section id="how" className="section">
          <p className="section-eyebrow reveal">How it works</p>
          <h2 className="section-title reveal">One room, your streaming services, <em>zero switching.</em></h2>
          <div className="step-grid">
            {steps.map((s) => (
              <div key={s.n} className="step-card reveal">
                <i className="step-rule" aria-hidden />
                <span className="step-num">{s.n}]</span>
                <h3>{s.t}</h3>
                <p>{s.d}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Room Showcase */}
        <section id="showcase" className="section">
          <p className="section-eyebrow reveal">In the room right now</p>
          <h2 className="section-title reveal">See it <em>in sync.</em></h2>
          <p className="max-w-2xl mx-auto text-center reveal" style={{ color: 'var(--color-text-secondary)', marginBottom: '2.5rem' }}>
            Watch how CoJam keeps everyone&rsquo;s queue in perfect sync while each person plays on their own service.
          </p>
          <RoomShowcase />
        </section>

        {/* Alone vs in a room (Direction B borrow: evidence as comparison table) */}
        <section id="vs" className="section">
          <p className="section-eyebrow reveal">Why a room</p>
          <h2 className="section-title reveal">
            Alone works. <em>Together hits different.</em>
          </h2>
          <table className="vs-table">
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">Topic</span></th>
                <th scope="col">Listening alone</th>
                <th scope="col">In a CoJam room</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Queue</th>
                <td>You, alone</td>
                <td><span className="vs-yes"><CheckIcon size={14} /> Everyone adds, everyone hears</span></td>
              </tr>
              <tr>
                <th scope="row">Inviting</th>
                <td>Send songs one by one</td>
                <td><span className="vs-yes"><CheckIcon size={14} /> One link</span></td>
              </tr>
              <tr>
                <th scope="row">Services</th>
                <td>Everyone needs the same one</td>
                <td><span className="vs-yes"><CheckIcon size={14} /> Each brings their own</span></td>
              </tr>
              <tr>
                <th scope="row">Sync</th>
                <td>Count down out loud, press play</td>
                <td><span className="vs-yes"><CheckIcon size={14} /> Automatic, on metadata</span></td>
              </tr>
              <tr>
                <th scope="row">Setup</th>
                <td>An app per person</td>
                <td><span className="vs-yes"><CheckIcon size={14} /> A browser tab</span></td>
              </tr>
            </tbody>
          </table>
        </section>

        {/* Platforms */}
        <section id="platforms" className="section" style={{ textAlign: 'center' }}>
          <p className="section-eyebrow reveal">Works with</p>
          <h2 className="section-title reveal">Bring the service <em>you already pay for.</em></h2>
          <div className="platform-row">
            {platforms.map(([name, live]) => {
              const Icon = platformIcons[name];
              return (
                <span key={name} className="platform-chip reveal inline-flex items-center gap-2" data-live={live ? '1' : '0'}>
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
            Start a room <em>in one click.</em>
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
