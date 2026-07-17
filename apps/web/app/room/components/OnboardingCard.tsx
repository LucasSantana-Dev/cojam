'use client';

import { LinkIcon, PlusIcon, PlayIcon } from '@/app/components/icons';

// First-run guide shown while the room is empty. It disappears on its own once a
// track is queued, so no dismiss state is needed.
const STEPS = [
  {
    Icon: LinkIcon,
    title: 'Invite your friends',
    body: 'Hit Invite up top to copy the room link, then send it to whoever you want listening.',
  },
  {
    Icon: PlusIcon,
    title: 'Add a song',
    body: 'Paste a YouTube or Spotify link (or its ID) into Add Track. Everyone sees it in the queue.',
  },
  {
    Icon: PlayIcon,
    title: 'Listen together',
    body: 'Press play on a track. Each person streams it on their own account, kept in sync by the room.',
  },
];

export function OnboardingCard() {
  return (
    <section className="panel p-6 space-y-4" aria-labelledby="onboarding-heading">
      <div className="space-y-1">
        <h2 id="onboarding-heading" className="text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          Get the room going
        </h2>
        <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          Three steps and you are listening together.
        </p>
      </div>
      <ol className="space-y-3">
        {STEPS.map(({ Icon, title, body }, i) => (
          <li key={title} className="flex items-start gap-3">
            <span
              className="inline-flex items-center justify-center rounded-lg shrink-0"
              style={{ width: 36, height: 36, background: 'oklch(0.66 0.2 300 / 0.12)', color: 'var(--color-accent)' }}
              aria-hidden
            >
              <Icon size={18} />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
                {i + 1}. {title}
              </div>
              <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                {body}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
