'use client';

import { SpotifyIcon, YouTubeIcon, AppleMusicIcon, PlayIcon, ArrowUpIcon, ArrowDownIcon, TrashIcon } from '@/app/components/icons';

const roomData = {
  roomId: 'NEON-4821',
  presence: [
    { initials: 'L', name: 'Lucas', color: '#a06bff' },
    { initials: 'M', name: 'Maria', color: '#60a5fa' },
    { initials: 'T', name: 'Théo', color: '#34d399' },
  ],
  nowPlaying: {
    title: 'Instant Crush',
    artist: 'Daft Punk & Julian Casablancas',
    albumArt: 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/e8/43/5f/e8435ffa-b6b9-b171-40ab-4ff3959ab661/886443919266.jpg/600x600bb.jpg',
    albumAlt: 'Random Access Memories album cover',
    source: 'spotify' as const,
  },
  queue: [
    {
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      addedBy: 'Maria',
      source: 'apple' as const,
      confidence: 100,
      albumArt: 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/a6/6e/bf/a66ebf79-5008-8948-b352-a790fc87446b/19UM1IM04638.rgb.jpg/600x600bb.jpg',
      albumAlt: 'After Hours album cover',
    },
    {
      title: 'Borderline',
      artist: 'Tame Impala',
      addedBy: 'Théo',
      source: 'youtube' as const,
      confidence: 98,
      albumArt: 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/65/e3/e7/65e3e740-b69f-f5cb-f2e6-7dedb5265ac9/19UMGIM96748.rgb.jpg/600x600bb.jpg',
      albumAlt: 'The Slow Rush album cover',
    },
    {
      title: 'Levitating',
      artist: 'Dua Lipa',
      addedBy: 'Lucas',
      source: 'spotify' as const,
      confidence: 100,
      albumArt: 'https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/6c/11/d6/6c11d681-aa3a-d59e-4c2e-f77e181026ab/190295092665.jpg/600x600bb.jpg',
      albumAlt: 'Future Nostalgia album cover',
    },
    {
      title: 'Delilah',
      artist: 'fred again.. & Delilah Montagu',
      addedBy: 'Maria',
      source: 'apple' as const,
      confidence: 95,
      albumArt: 'https://is1-ssl.mzstatic.com/image/thumb/Music122/v4/b0/9c/b7/b09cb72c-cca9-5d66-bc9d-a9b5e5f86b22/5054197236389.jpg/600x600bb.jpg',
      albumAlt: 'Actual Life 3 album cover',
    },
  ],
};

const sourceConfig = {
  spotify: { Icon: SpotifyIcon, label: 'Spotify', color: '#a06bff' },
  apple: { Icon: AppleMusicIcon, label: 'Apple', color: '#60a5fa' },
  youtube: { Icon: YouTubeIcon, label: 'YouTube', color: '#ef4444' },
};

// Intentionally standalone promo mockup: static data, self-contained styles.
// It previews the room UI for the landing page and is NOT wired to the real
// room components; keep divergence deliberate, not accidental.
export function RoomShowcase() {
  return (
    <div
      className="room-showcase relative w-full max-w-2xl mx-auto px-4 py-12 reveal"
      style={{ ['--i' as string]: 0 }}
    >
      {/* Soft violet glow behind the card. Sits OUTSIDE the overflow-hidden card,
          as a sibling, or the clip would swallow it entirely. */}
      <div
        aria-hidden
        className="absolute -inset-10 pointer-events-none"
        style={{
          background: 'radial-gradient(circle, color-mix(in oklab, var(--color-accent) 15%, transparent), transparent 65%)',
          filter: 'blur(40px)',
        }}
      />

      {/* Frosted glass card container with premium lighting.
          Glass gradient + shadow stops are deliberate one-offs (no token equivalents). */}
      <div
        className="relative rounded-2xl p-6 overflow-hidden"
        style={{
          background: 'linear-gradient(135deg, oklch(0.16 0.01 280 / 0.7) 0%, oklch(0.12 0.01 280 / 0.7) 100%)',
          backdropFilter: 'blur(12px) saturate(1.2)',
          WebkitBackdropFilter: 'blur(12px) saturate(1.2)',
          border: '1px solid oklch(0.3 0.02 280 / 0.6)',
          boxShadow: `
            0 1px 0 0 oklch(1 0 0 / 0.04) inset,
            0 30px 70px -40px oklch(0 0 0 / 0.55)
          `,
        }}
      >
        {/* Film grain overlay (very subtle texture) */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
            opacity: 0.03,
            mixBlendMode: 'overlay',
          }}
        />

        <div className="relative z-10 space-y-6">
          {/* Header: Room label + Presence + Status */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-[var(--color-accent)]/10">
            <div>
              <h3 className="text-sm font-mono uppercase tracking-widest text-[var(--color-accent)]">
                Room: {roomData.roomId}
              </h3>
            </div>

            <div className="flex items-center gap-3">
              {/* Presence avatar stack */}
              <div className="flex -space-x-2">
                {roomData.presence.map((p) => (
                  <div
                    key={p.initials}
                    className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-black border-2"
                    style={{
                      backgroundColor: p.color,
                      borderColor: 'var(--color-surface-1)',
                    }}
                    title={p.name}
                  >
                    {p.initials}
                  </div>
                ))}
              </div>

              {/* Connected status pill */}
              <div
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium"
                style={{
                  background: 'color-mix(in oklab, var(--color-accent) 10%, transparent)',
                  border: '1px solid color-mix(in oklab, var(--color-accent) 30%, transparent)',
                  color: 'var(--color-text-primary)',
                }}
              >
                <div
                  className="w-2 h-2 rounded-full animate-pulse-breath"
                  style={{ backgroundColor: 'var(--color-accent)' }}
                />
                Connected
              </div>
            </div>
          </div>

          {/* Now-playing panel (large album art + equalizer) */}
          <div
            className="p-4 rounded-lg showcase-now-playing"
            style={{
              background: 'color-mix(in oklab, var(--color-surface-3) 50%, transparent)',
              border: '1px solid color-mix(in oklab, var(--color-accent) 40%, transparent)',
              boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-accent) 20%, transparent)',
            }}
          >
            <div className="flex flex-col sm:flex-row items-center gap-4">
              {/* Large album art */}
              <img
                src={roomData.nowPlaying.albumArt}
                alt={roomData.nowPlaying.albumAlt}
                className="w-24 h-24 rounded-lg object-cover flex-shrink-0"
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
              />

              {/* Now-playing info + equalizer */}
              <div className="flex-1 min-w-0 text-center sm:text-left">
                <div className="flex items-center justify-center sm:justify-start gap-2 mb-2">
                  <span className="text-xs font-mono uppercase tracking-widest text-[var(--color-accent)]">
                    Now Playing
                  </span>
                  <div className="eq">
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                </div>

                <h4 className="font-semibold text-base truncate">
                  {roomData.nowPlaying.title}
                </h4>
                <p
                  className="text-sm truncate"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {roomData.nowPlaying.artist}
                </p>

                {/* Progress bar (scrubbed by scroll; controlled via --progress) */}
                <div
                  className="mt-3 h-1 rounded-full overflow-hidden"
                  style={{ background: 'var(--color-border)' }}
                >
                  <div
                    className="h-full rounded-full transition-none"
                    style={{
                      background: 'var(--color-accent)',
                      width: 'var(--progress, 35%)',
                    }}
                  />
                </div>
              </div>

              {/* Source badge */}
              <div className="flex-shrink-0">
                {(() => {
                  const cfg = sourceConfig[roomData.nowPlaying.source];
                  return (
                    <div
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium"
                      style={{
                        background: `${cfg.color}22`,
                        border: `1px solid ${cfg.color}44`,
                        color: cfg.color,
                      }}
                    >
                      <cfg.Icon size={14} />
                      {cfg.label}
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>

          {/* Queue list */}
          <div className="space-y-2">
            <h5
              className="text-xs font-mono uppercase tracking-widest px-2"
              style={{ color: 'var(--color-text-muted)' }}
            >
              Queue
            </h5>

            <div className="space-y-1.5 showcase-queue-list">
              {roomData.queue.map((item, idx) => {
                const cfg = sourceConfig[item.source];
                return (
                  <div
                    key={item.title}
                    className="group queue-row p-3 rounded-lg"
                    data-queue-index={idx}
                    style={{
                      background: 'color-mix(in oklab, var(--color-surface-2) 60%, transparent)',
                      border: '1px solid var(--color-border)',
                    }}
                  >
                    <div className="flex items-center gap-3">
                      {/* Queue item number + album art */}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span
                          className="text-xs font-mono"
                          style={{ color: 'var(--color-text-muted)' }}
                        >
                          {idx + 1}
                        </span>
                        <img
                          src={item.albumArt}
                          alt={item.albumAlt}
                          className="w-10 h-10 rounded object-cover"
                          loading="lazy"
                          decoding="async"
                          referrerPolicy="no-referrer"
                        />
                      </div>

                      {/* Title + artist + added by */}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">
                          {item.title}
                        </div>
                        <div
                          className="text-xs truncate"
                          style={{ color: 'var(--color-text-muted)' }}
                        >
                          {item.artist} · added by {item.addedBy}
                        </div>
                      </div>

                      {/* Source badge + confidence chip */}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {/* Confidence chip (mono face, minimal) */}
                        <span
                          className="inline-flex items-center justify-center px-2 py-1 rounded text-xs font-mono font-semibold"
                          style={{
                            background: 'color-mix(in oklab, var(--color-accent) 10%, transparent)',
                            color: 'var(--color-accent)',
                            minWidth: '2.5rem',
                          }}
                        >
                          {item.confidence}%
                        </span>

                        {/* Source badge */}
                        <div
                          className="inline-flex items-center justify-center w-8 h-8 rounded-lg"
                          style={{
                            background: `${cfg.color}22`,
                            border: `1px solid ${cfg.color}44`,
                            color: cfg.color,
                          }}
                          title={cfg.label}
                        >
                          <cfg.Icon size={14} />
                        </div>
                      </div>

                      {/* Action buttons (hover-revealed on desktop) */}
                      <div className="hidden sm:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex-shrink-0">
                        <button
                          className="p-1.5 rounded transition-colors duration-150 hover:bg-[var(--color-accent)]/10"
                          style={{ color: 'var(--color-text-secondary)' }}
                          aria-label="Play"
                          type="button"
                        >
                          <PlayIcon size={16} />
                        </button>
                        <button
                          className="p-1.5 rounded transition-colors duration-150 hover:bg-[var(--color-accent)]/10"
                          style={{ color: 'var(--color-text-secondary)' }}
                          aria-label="Move up"
                          type="button"
                        >
                          <ArrowUpIcon size={16} />
                        </button>
                        <button
                          className="p-1.5 rounded transition-colors duration-150 hover:bg-[var(--color-accent)]/10"
                          style={{ color: 'var(--color-text-secondary)' }}
                          aria-label="Move down"
                          type="button"
                        >
                          <ArrowDownIcon size={16} />
                        </button>
                        <button
                          className="p-1.5 rounded transition-colors duration-150 hover:bg-red-500/20"
                          style={{ color: '#ef4444' }}
                          aria-label="Remove"
                          type="button"
                        >
                          <TrashIcon size={16} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
