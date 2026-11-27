// Client for the feature flag panel (/admin/flags). The Go server serves the
// API on the same origin (Caddy routes /api/* to it; next.config.ts rewrites
// it in dev) behind ADMIN_TOKEN, sent as a bearer token. See
// apps/server/cmd/server/admin_flags.go and docs/specs/feature-flags-panel.md.

export type FlagValue = {
  enabled: boolean | null;
  roomAllowlist: string[] | null;
};

export type AdminFlag = {
  name: string;
  label: string;
  help: string;
  default: boolean;
  serverEnv: { name: string; value?: boolean };
  webEnv: string;
  allowlistEnv?: { name: string; rooms?: string[] };
  override: (FlagValue & { updatedAt: string; updatedBy: string }) | null;
  effective: {
    enabled: boolean;
    source: 'override' | 'env' | 'default';
    roomAllowlist: string[] | null;
    roomAllowlistSource?: 'override' | 'env';
  };
  blocked?: string;
};

export type FlagChange = {
  id: number;
  name: string;
  before: FlagValue;
  after: FlagValue;
  actor: string;
  note: string;
  createdAt: string;
};

export type AdminFlagsState = {
  flags: AdminFlag[];
  changes: FlagChange[];
  writable: boolean;
  pollSeconds: number;
};

// AdminError carries the HTTP status so the panel can tell a wrong token
// (401) from a panel that is switched off (404).
export class AdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

const TOKEN_KEY = 'cojam.adminToken';

// The token lives in sessionStorage only: it dies with the tab, never
// reaches localStorage, and a blocked storage just means typing it again.
export function loadToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: the token stays in memory for this page only.
  }
}

async function call<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      cache: 'no-store',
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
    });
  } catch {
    throw new AdminError(0, 'Sem conexão com o servidor.');
  }
  if (res.status === 404 && path === '/api/admin/flags') {
    throw new AdminError(404, 'O painel está desligado neste servidor: defina ADMIN_TOKEN (32+ caracteres).');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error page.
  }
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `O servidor respondeu ${res.status}.`;
    throw new AdminError(res.status, msg);
  }
  return body as T;
}

export function fetchFlags(token: string): Promise<AdminFlagsState> {
  return call<AdminFlagsState>(token, '/api/admin/flags');
}

export function updateFlag(
  token: string,
  name: string,
  value: FlagValue & { note: string },
): Promise<AdminFlag> {
  return call<AdminFlag>(token, `/api/admin/flags/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}

// parseRooms turns the panel's free text (commas, spaces or lines) into
// upper-case room codes, deduplicated, in order.
export function parseRooms(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const id = part.trim().toUpperCase();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

// describeValue renders an override for the history list.
export function describeValue(v: FlagValue): string {
  const enabled = v.enabled === null ? 'padrão do ambiente' : v.enabled ? 'ligada' : 'desligada';
  if (v.roomAllowlist === null) return enabled;
  const rooms = v.roomAllowlist.length === 0 ? 'todas as salas' : v.roomAllowlist.join(', ');
  return `${enabled}, salas: ${rooms}`;
}
