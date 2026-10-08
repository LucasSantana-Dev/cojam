import { spotifyConnectMessage, type SpotifyConnectErrorKind } from '@/lib/spotifyConnectError';

// Shown in the now-playing card (the Spotify player itself sits in the closed
// avatar menu). Every state offers the one-tap way out: listen on YouTube.
export function SpotifyProblemNote({
  kind,
  onRetry,
  onUseYouTube,
}: {
  kind: SpotifyConnectErrorKind;
  onRetry?: () => void;
  onUseYouTube?: () => void;
}) {
  return (
    <div className="r4-service__note" role="alert" data-testid="spotify-problem-note">
      <p style={{ margin: 0 }}>{spotifyConnectMessage(kind)}</p>
      <div className="flex flex-wrap gap-2" style={{ marginTop: '0.25rem' }}>
        {onRetry && (
          <button type="button" className="r4-svclist__btn" style={{ border: '1px solid var(--r4-line)', minHeight: '2.75rem' }} onClick={onRetry}>
            Tocar no Spotify
          </button>
        )}
        {onUseYouTube && (
          <button type="button" className="r4-svclist__btn" style={{ border: '1px solid var(--r4-line)', minHeight: '2.75rem' }} onClick={onUseYouTube}>
            Tocar pelo YouTube
          </button>
        )}
      </div>
    </div>
  );
}
