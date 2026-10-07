import { useEffect, useState } from 'react';
import { IDLE_TINT, analyzeImageUrl, type Tint } from './trackColor';

export type TrackColors = { tint: Tint; palette: Tint[] | null };
const IDLE: TrackColors = { tint: IDLE_TINT, palette: null };

/**
 * Ground colour (and 4-colour palette) of the cover at `url`. Holds the previous
 * colours while the next cover loads (the CSS crossfade does the rest) and falls
 * back to the idle violet with no palette.
 */
export function useTrackColors(url: string | null): TrackColors & { url: string | null } {
  const [state, setState] = useState<TrackColors & { url: string | null }>({ ...IDLE, url: null });
  useEffect(() => {
    let cancelled = false;
    if (!url) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to the idle ground when the track has no cover
      setState({ ...IDLE, url: null });
      return;
    }
    analyzeImageUrl(url).then((res) => {
      if (!cancelled) setState(res ? { tint: res.tint, palette: res.palette, url } : { ...IDLE, url });
    });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return state;
}

export function useTrackColor(url: string | null): Tint {
  return useTrackColors(url).tint;
}
