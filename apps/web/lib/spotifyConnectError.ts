import type { AccountCheck } from './spotifyAccount';

// Why a Spotify connect attempt failed, and what to tell the person. Pure, so
// every case is unit-tested. Messages never carry tokens, codes or response
// bodies: only a kind, mapped to fixed PT-BR copy.

export type SpotifyConnectErrorKind =
  | 'denied' // user pressed Cancel on Spotify's consent screen
  | 'rejected' // Spotify refused (dev-mode allowlist, invalid grant, 403)
  | 'server' // our exchange endpoint is missing or failing (404, 5xx)
  | 'rateLimited' // 429 from our exchange endpoint
  | 'session' // no connection token / 401 from our server
  | 'network' // fetch itself failed
  | 'expired' // missing state or PKCE verifier: the flow was interrupted
  | 'sdk' // the Web Playback SDK failed to load or initialise
  | 'premium' // account is not Premium, Web Playback SDK refuses it
  | 'reconnect' // server no longer holds the grant
  | 'unknown';

export class SpotifyConnectError extends Error {
  readonly kind: SpotifyConnectErrorKind;
  constructor(kind: SpotifyConnectErrorKind) {
    super(`spotify connect failed: ${kind}`);
    this.name = 'SpotifyConnectError';
    this.kind = kind;
  }
}

const MESSAGES: Record<SpotifyConnectErrorKind, string> = {
  denied: 'Você cancelou a autorização no Spotify.',
  rejected:
    'O Spotify não aceitou a conexão. Se o app está em modo de desenvolvimento, confira se sua conta está na lista de testadores; senão, tente de novo.',
  server: 'Não conseguimos concluir a conexão com o Spotify (erro do servidor). Tente de novo em instantes.',
  rateLimited: 'Muitas tentativas seguidas. Espere um instante e tente de novo.',
  session: 'Não conseguimos validar sua sessão na sala. Tente de novo em instantes.',
  network: 'Sem conexão com o servidor. Confira sua internet e tente de novo.',
  expired: 'A autorização expirou ou foi aberta em outra aba. Comece de novo.',
  sdk: 'O player do Spotify não iniciou. Recarregue a página para tentar de novo.',
  premium: 'O player do Spotify precisa de uma conta Premium. A sala continua tocando pelo YouTube.',
  reconnect: 'Sua conexão com o Spotify expirou. Conecte de novo.',
  unknown: 'Não deu para conectar o Spotify. Tente de novo.',
};

export function spotifyConnectMessage(kind: SpotifyConnectErrorKind): string {
  return MESSAGES[kind];
}

// Premium is a property of the account and an SDK failure is not an OAuth
// problem, so re-running the authorization cannot help either.
export function canRetrySpotifyConnect(kind: SpotifyConnectErrorKind): boolean {
  return kind !== 'premium' && kind !== 'sdk';
}

// Status of POST /api/spotify/token (the exchange).
export function kindFromExchangeStatus(status: number): SpotifyConnectErrorKind {
  if (status === 401) return 'session';
  if (status === 429) return 'rateLimited';
  // 400 is our own malformed request, not Spotify's verdict. 502 is Spotify
  // refusing the exchange (or the call to it failing).
  if (status === 502) return 'rejected';
  if (status === 400) return 'server';
  // 404 means the route is not mounted (server env incomplete), 501 means
  // Spotify is not configured, anything else 5xx is ours.
  if (status === 404 || status >= 500) return 'server';
  return 'unknown';
}

const REJECTED_AUTH_ERRORS = new Set(['invalid_scope', 'unauthorized_client', 'invalid_client', 'invalid_request']);

// `?error=` echoed by Spotify on the callback URL.
export function kindFromAuthorizeError(error: string | null): SpotifyConnectErrorKind | null {
  if (!error) return null;
  if (error === 'access_denied') return 'denied';
  if (REJECTED_AUTH_ERRORS.has(error)) return 'rejected';
  return 'unknown';
}

// Outcome of the /v1/me probe. A 403 there is the signature of a Development
// Mode app whose allowlist does not include this account.
export function kindFromAccountCheck(check: AccountCheck): SpotifyConnectErrorKind | null {
  switch (check) {
    case 'premium':
      return null;
    case 'free':
      return 'premium';
    case 'forbidden':
      return 'rejected';
    case 'unauthorized':
      return 'reconnect';
    default:
      return 'unknown';
  }
}

export function kindFromError(e: unknown): SpotifyConnectErrorKind {
  return e instanceof SpotifyConnectError ? e.kind : 'unknown';
}
