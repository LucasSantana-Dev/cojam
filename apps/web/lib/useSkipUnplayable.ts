import { useCallback, useEffect, useRef, useState } from 'react';
import { nowPlayingSkipUnplayable, isPermissionDeniedError } from '@/lib/realtime';

// How long a controller waits after the YouTube player reports an unplayable
// video (embed blocked) before skipping it: long enough for the failed card to
// show and for a transient error to clear.
export const SKIP_UNPLAYABLE_DELAY_MS = 2000;

// Auto-skips a now-playing track whose YouTube embed cannot play. Only a
// controller's client skips (the server enforces the same gate); everyone else
// just sees the failed card. Returns the YouTubePlayer onPlayError handler
// (a track id on failure, null once something plays). One skip per track id,
// and the id is re-checked when the timer fires so a track change during the
// delay never skips the new track.
export function useSkipUnplayable(roomId: string, nowPlayingId: string | undefined, canSkip: boolean) {
  const [failedId, setFailedId] = useState<string | null>(null);
  const skipped = useRef<Set<string>>(new Set());
  const nowRef = useRef(nowPlayingId);
  useEffect(() => {
    nowRef.current = nowPlayingId;
  }, [nowPlayingId]);

  useEffect(() => {
    if (!canSkip || !failedId || failedId !== nowPlayingId || skipped.current.has(failedId)) return;
    const id = failedId;
    const timer = setTimeout(() => {
      if (nowRef.current !== id || skipped.current.has(id)) return;
      skipped.current.add(id);
      nowPlayingSkipUnplayable(roomId, id).catch((err) => {
        if (!isPermissionDeniedError(err)) console.error('Skip unplayable error:', err);
      });
    }, SKIP_UNPLAYABLE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [roomId, failedId, nowPlayingId, canSkip]);

  return useCallback((trackId: string | null) => setFailedId(trackId), []);
}
