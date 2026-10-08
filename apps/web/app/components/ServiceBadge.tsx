import { platformIcon } from './icons';

// The small coloured service mark on avatars and in the avatar menu. This is the
// only place a brand colour may appear in the room (.svc-badge in globals.css,
// enforced by scripts/check_web_drift.sh). Everything else stays monochrome.
export type ServiceSource = keyof typeof platformIcon;

const LABEL: Record<ServiceSource, string> = { spotify: 'Spotify', apple: 'Apple Music', youtube: 'YouTube' };

export function ServiceBadge({ source, size = 'md', title }: { source: ServiceSource; size?: 'sm' | 'md' | 'lg'; title?: string }) {
  const Icon = platformIcon[source];
  return (
    <span className="svc-badge" data-svc={source} data-size={size} title={title ?? LABEL[source]}>
      <Icon size={size === 'lg' ? 18 : size === 'sm' ? 9 : 13} />
    </span>
  );
}
