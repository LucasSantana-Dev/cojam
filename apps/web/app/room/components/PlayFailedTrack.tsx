export function PlayFailedTrack() {
  return (
    <div className="hero-unavailable">
      <p className="text-lg font-medium" style={{ color: 'var(--color-text-primary)' }}>
        Couldn&apos;t play this track on your service
      </p>
      <p className="text-sm mt-2" style={{ color: 'var(--color-text-secondary)' }}>
        The track may be removed or restricted on your connected provider. Others in the room may still be listening.
      </p>
    </div>
  );
}
