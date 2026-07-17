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

export function RoomShowcase() {
  return (
    <div
      className="room-showcase relative w-full max-w-2xl mx-auto px-4 py-12 reveal"
      style={{ ['--i' as string]: 0 }}
    >
      {/* Frosted glass card container with premium lighting */}
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

        {/* Soft violet glow (behind the card, creates depth) */}
        <div
          className="absolute -inset-32 pointer-events-none -z-10"
          style={{
            background: 'radial-gradient(circle, oklch(0.66 0.2 300 / 0.15), transparent 65%)',
            filter: 'blur(40px)',
          }}
        />

        <div className="relative z-10 space-y-6">
          {/* Header: Room label + Presence + Status */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-[oklch(0.66_0.2_300)]/10">
            <div>
              <h3 className="text-sm font-mono uppercase tracking-widest text-[oklch(0.66_0.2_300)]">
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
                      borderColor: 'oklch(0.11 0.01 280)',
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
                  background: 'oklch(0.66 0.2 300 / 0.1)',
                  border: '1px solid oklch(0.66 0.2 300 / 0.3)',
                  color: 'oklch(0.96 0.01 280)',
                }}
              >
                <div
                  className="w-2 h-2 rounded-full animate-pulse-breath"
                  style={{ backgroundColor: 'oklch(0.66 0.2 300)' }}
                />
                Connected
              </div>
            </div>
          </div>

          {/* Now-playing panel (large album art + equalizer) */}
          <div
            className="p-4 rounded-lg"
            style={{
              background: 'oklch(0.18 0.01 280 / 0.5)',
              border: '1px solid oklch(0.66 0.2 300 / 0.4)',
              boxShadow: '0 0 0 1px oklch(0.66 0.2 300 / 0.2)',
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
              />

              {/* Now-playing info + equalizer */}
              <div className="flex-1 min-w-0 text-center sm:text-left">
                <div className="flex items-center justify-center sm:justify-start gap-2 mb-2">
                  <span className="text-xs font-mono uppercase tracking-widest text-[oklch(0.66_0.2_300)]">
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
                  style={{ color: 'oklch(0.62 0.02 280)' }}
                >
                  {roomData.nowPlaying.artist}
                </p>

                {/* Progress bar (faint) */}
                <div
                  className="mt-3 h-1 rounded-full overflow-hidden"
                  style={{ background: 'oklch(0.25 0.02 280)' }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      background: 'oklch(0.66 0.2 300)',
                      width: '35%',
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
              style={{ color: 'oklch(0.48 0.01 280)' }}
            >
              Queue
            </h5>

            <div className="space-y-1.5">
              {roomData.queue.map((item, idx) => {
                const cfg = sourceConfig[item.source];
                return (
                  <div
                    key={idx}
                    className="group p-3 rounded-lg transition-all duration-200"
                    style={{
                      background: 'oklch(0.14 0.01 280 / 0.6)',
                      border: '1px solid oklch(0.25 0.02 280)',
                    }}
                    onMouseEnter={(e) => {
                      if (window.matchMedia('(hover: hover)').matches) {
                        const el = e.currentTarget as HTMLElement;
                        el.style.borderColor = 'oklch(0.66 0.2 300 / 0.4)';
                        el.style.transform = 'translateY(-2px)';
                        el.style.boxShadow = '0 8px 16px -4px oklch(0.66 0.2 300 / 0.25)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (window.matchMedia('(hover: hover)').matches) {
                        const el = e.currentTarget as HTMLElement;
                        el.style.borderColor = 'oklch(0.25 0.02 280)';
                        el.style.transform = 'none';
                        el.style.boxShadow = 'none';
                      }
                    }}
                  >
                    <div className="flex items-center gap-3">
                      {/* Queue item number + album art */}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span
                          className="text-xs font-mono"
                          style={{ color: 'oklch(0.48 0.01 280)' }}
                        >
                          {idx + 1}
                        </span>
                        <img
                          src={item.albumArt}
                          alt={item.albumAlt}
                          className="w-10 h-10 rounded object-cover"
                          loading="lazy"
                          decoding="async"
                        />
                      </div>

                      {/* Title + artist + added by */}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">
                          {item.title}
                        </div>
                        <div
                          className="text-xs truncate"
                          style={{ color: 'oklch(0.48 0.01 280)' }}
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
                            background: 'oklch(0.66 0.2 300 / 0.1)',
                            color: 'oklch(0.66 0.2 300)',
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
                      <div
                        className="hidden sm:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex-shrink-0"
                        style={{
                          '@media (hover: hover)': {
                            visibility: 'visible',
                          },
                        } as any}
                      >
                        <button
                          className="p-1.5 rounded transition-colors duration-150 hover:bg-[oklch(0.66_0.2_300)]/10"
                          style={{ color: 'oklch(0.62 0.02 280)' }}
                          aria-label="Play"
                          type="button"
                        >
                          <PlayIcon size={16} />
                        </button>
                        <button
                          className="p-1.5 rounded transition-colors duration-150 hover:bg-[oklch(0.66_0.2_300)]/10"
                          style={{ color: 'oklch(0.62 0.02 280)' }}
                          aria-label="Move up"
                          type="button"
                        >
                          <ArrowUpIcon size={16} />
                        </button>
                        <button
                          className="p-1.5 rounded transition-colors duration-150 hover:bg-[oklch(0.66_0.2_300)]/10"
                          style={{ color: 'oklch(0.62 0.02 280)' }}
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
