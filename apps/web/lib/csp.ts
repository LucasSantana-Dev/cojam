// Content-Security-Policy for production, built from an explicit per-directive
// origin list. Kept in its own module so a unit test can assert every origin the
// player SDKs need and that no directive uses a bare wildcard source.
//
// Origins are the narrowest hosts each vendor SDK needs:
//  - YouTube IFrame API: script + player iframe on www.youtube.com, thumbnails
//    on i.ytimg.com (also derived in QueuePanel).
//  - Spotify Web Playback SDK: script and its player iframe on sdk.scdn.co,
//    Web API on api.spotify.com, OAuth on accounts.spotify.com, cover art on
//    the Spotify image CDNs.
//  - Artwork on *.mzstatic.com: the landing-page demo room covers.
// Artwork img-src stays an allowlist of vendor families on purpose (the server
// will later restrict artwork hosts to the same set). Deezer search results
// (cover_medium) arrive on *.dzcdn.net.

export const CSP_DIRECTIVES: Record<string, readonly string[]> = {
  'default-src': ["'self'"],
  // TODO: 'unsafe-inline' is required by Next.js inline bootstrap scripts.
  // Replace with a per-request nonce policy (separate, larger change).
  'script-src': [
    "'self'",
    "'unsafe-inline'",
    'https://www.youtube.com',
    'https://sdk.scdn.co',
  ],
  'style-src': ["'self'", "'unsafe-inline'"],
  'frame-src': ['https://www.youtube.com', 'https://sdk.scdn.co'],
  'img-src': [
    "'self'",
    'data:',
    // One subdomain wildcard per vendor family: the CDNs rotate edge hosts
    // (cdn-images / e-cdns-images, is1..is5-ssl, i / i9, image-cdn-ak / -fa ...).
    'https://*.mzstatic.com',
    'https://*.ytimg.com',
    'https://*.scdn.co',
    'https://*.spotifycdn.com',
    'https://*.dzcdn.net',
  ],
  'connect-src': [
    "'self'",
    'https://accounts.spotify.com',
    'https://api.spotify.com',
    'https://*.supabase.co',
  ],
  'media-src': ["'self'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'object-src': ["'none'"],
};

export function buildCsp(directives: Record<string, readonly string[]> = CSP_DIRECTIVES): string {
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}
