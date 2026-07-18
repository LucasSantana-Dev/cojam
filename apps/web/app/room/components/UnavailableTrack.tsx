export function UnavailableTrack() {
  return (
    <div className="hero-unavailable">
      <p className="text-lg font-medium" style={{ color: 'var(--color-text-primary)' }}>
        Not available on your connected services
      </p>
      <p className="text-sm mt-2" style={{ color: 'var(--color-text-secondary)' }}>
        This track has no source compatible with Spotify or YouTube. Try adding another track or connecting a different service.
      </p>
    </div>
  );
}
