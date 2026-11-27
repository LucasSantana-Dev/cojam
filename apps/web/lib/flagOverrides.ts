// Runtime feature flag overrides (docs/specs/feature-flags-panel.md).
//
// The owner flips flags in /admin/flags; the Go server stores the override
// and serves the overridden flags at GET /api/features. /env.js (server side,
// per request) merges them over its own COJAM_FEATURE_* values, so a flag
// changes for the next page load without editing the homelab .env or
// recreating a container.
//
// The server is reached at COJAM_SERVER_URL (the internal address, e.g.
// http://cojam-server:8080), else SERVER_ORIGIN (dev), else the http(s)
// origin of COJAM_WS_URL. Reads are cached for a few seconds and bounded by a
// short timeout; a failed read keeps the last good map, and with none /env.js
// simply serves the environment as before.
import { FEATURE_ENV_VARS, type FeatureName } from './features';

export type FlagOverrides = Partial<Record<FeatureName, boolean>>;

const TTL_MS = 5_000;
const TIMEOUT_MS = 1_000;

// serverBase picks the Go server's http origin from the environment, or ''
// when nothing names it.
export function serverBase(env: Record<string, string | undefined>): string {
  for (const raw of [env.COJAM_SERVER_URL, env.SERVER_ORIGIN]) {
    if (raw && raw.trim()) return raw.trim().replace(/\/+$/, '');
  }
  const ws = env.COJAM_WS_URL?.trim();
  if (!ws) return '';
  try {
    const url = new URL(ws);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return '';
    return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
  } catch {
    return '';
  }
}

// parseOverrides keeps only known flag names with boolean values: the
// response is data from another process and must not inject anything else
// into /env.js.
export function parseOverrides(body: unknown): FlagOverrides {
  const out: FlagOverrides = {};
  if (!body || typeof body !== 'object') return out;
  const features = (body as { features?: unknown }).features;
  if (!features || typeof features !== 'object') return out;
  for (const name of Object.keys(FEATURE_ENV_VARS) as FeatureName[]) {
    const v = (features as Record<string, unknown>)[name];
    if (typeof v === 'boolean') out[name] = v;
  }
  return out;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// createOverrideSource returns a cached reader. Exported for tests; the app
// uses getFlagOverrides below.
export function createOverrideSource(opts: {
  base: () => string;
  fetchFn?: Fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}) {
  const fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? TTL_MS;
  const timeout = opts.timeoutMs ?? TIMEOUT_MS;
  let last: FlagOverrides = {};
  let fetchedAt = -Infinity;
  let inflight: Promise<FlagOverrides> | null = null;

  return async function read(): Promise<FlagOverrides> {
    const base = opts.base();
    if (!base) return {};
    if (now() - fetchedAt < ttl) return last;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const res = await fetchFn(`${base}/api/features`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(timeout),
        });
        if (res.ok) last = parseOverrides(await res.json());
      } catch {
        // Keep the last good map; /env.js falls back to the environment.
      } finally {
        // A failure also waits out the TTL, so a down server does not add the
        // timeout to every page load.
        fetchedAt = now();
        inflight = null;
      }
      return last;
    })();
    return inflight;
  };
}

export const getFlagOverrides = createOverrideSource({ base: () => serverBase(process.env) });
