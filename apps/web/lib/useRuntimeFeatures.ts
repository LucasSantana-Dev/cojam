// Hydration-safe runtime feature flags (RFC-0006).
//
// The build-time `features` map is the server snapshot, so SSR and the first
// client render agree; the /env.js runtime map is merged in right after
// hydration, flipping any overridden flags post-mount (a brief, acceptable
// flash, same trade-off as #62's Spotify button). One hook, used everywhere,
// so no per-site mismatch.

import { useSyncExternalStore } from 'react';
import { features, type Features, type FeatureName } from './features';
import { getRuntimeEnv, resolveRuntimeFeatures } from './runtimeEnv';

// /env.js loads beforeInteractive and never changes afterwards, so the merged
// map is computed once and cached: useSyncExternalStore requires getSnapshot to
// return a stable value between renders. Re-resolved only if the injected
// features object itself is swapped (tests do this; production never does).
let cachedSource: Partial<Record<FeatureName, boolean>> | undefined;
let cached: Features | null = null;

// Client snapshot: build-time defaults with the runtime /env.js map merged over.
export function resolveClientFeatures(): Features {
  const source = getRuntimeEnv()?.features;
  if (!cached || source !== cachedSource) {
    cached = resolveRuntimeFeatures(features, source);
    cachedSource = source;
  }
  return cached;
}

// Runtime env (/env.js) never changes after load; nothing to subscribe to.
const noopSubscribe = () => () => {};

export function useRuntimeFeatures(): Features {
  return useSyncExternalStore(noopSubscribe, resolveClientFeatures, () => features);
}
