import type { ReactNode } from 'react';

/**
 * The room's big-media surface (#258). Generic on purpose: `children` is the
 * media element (a YouTube player today, a screen-share <video> in #310), and
 * `overlay` / `caption` are optional slots, so nothing here knows about a
 * specific player.
 *
 * Sizing is the stage's job: the frame holds a 16:9 box and the media element
 * fills it (`.stage-frame > *` and iframes are stretched in globals.css), so a
 * host never has to size the player itself.
 *
 * Pinning on mobile is layout, not behaviour: `.stage` is sticky below 768px
 * and static from there up, controlled entirely by CSS (see globals.css).
 */
export function Stage({
  children,
  overlay,
  caption,
  label = 'Stage',
}: {
  children: ReactNode;
  /** Rendered on top of the media (status chip, reaction layer, error card). */
  overlay?: ReactNode;
  /** Rendered under the media (title, who added it). */
  caption?: ReactNode;
  /** Accessible name for the landmark. */
  label?: string;
}) {
  return (
    <section className="stage" data-testid="stage" aria-label={label}>
      <div className="stage-frame">
        {children}
        {overlay && (
          <div className="stage-overlay" data-testid="stage-overlay">
            {overlay}
          </div>
        )}
      </div>
      {caption && (
        <div className="stage-caption" data-testid="stage-caption">
          {caption}
        </div>
      )}
    </section>
  );
}
