// Client telemetry (#245/#251). Posts to the Go server, which folds each report
// into the existing Prometheus surface. No third-party vendor and no data
// leaves the host — see docs/specs/245-251-client-telemetry.md.
//
// Names must match the server's allowlist; anything else is rejected with 400.
import { resolveClientFeatures } from './useRuntimeFeatures';

// `second_listener` is intentionally absent: the server already counts it as
// music_jam_rooms_shared_total, incremented on a room's first non-creator
// member (#180). Reporting it from the client too would double-count and be
// per-browser rather than per-room.
export type ProductEvent =
  | 'landing_view'
  | 'room_create'
  | 'room_join'
  | 'track_added'
  | 'provider_connected';

export type ClientErrorName =
  | 'boundary_segment'
  | 'boundary_root'
  | 'ws_terminal'
  | 'playback_failed'
  | 'token_refresh_failed';

const ENDPOINT = '/api/telemetry';

// Fire and forget: telemetry must never block a user action, never retry, and
// never surface a failure. A dropped report is strictly better than a UI stall.
function send(body: object): void {
  if (typeof window === 'undefined') return;
  if (!resolveClientFeatures().telemetry) return;

  const payload = JSON.stringify(body);
  try {
    // sendBeacon survives page unload, which is exactly when the last event of
    // a session fires. It is unavailable in some browsers, hence the fallback.
    if (navigator.sendBeacon?.(ENDPOINT, new Blob([payload], { type: 'application/json' }))) {
      return;
    }
    void fetch(ENDPOINT, {
      method: 'POST',
      body: payload,
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Never let telemetry throw into a caller.
  }
}

export function trackEvent(name: ProductEvent): void {
  send({ type: 'event', name });
}

export function trackVital(name: string, value: number): void {
  send({ type: 'vital', name, value });
}

// `detail` carries the error type and message only. Never a stack trace and
// never a URL: room IDs are capabilities, so a URL leaks one.
export function trackError(name: ClientErrorName, err?: unknown): void {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : '';
  send({ type: 'error', name, detail });
}
