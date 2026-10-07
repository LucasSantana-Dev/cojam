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
//  - Apple MusicKit JS v3: script on js-cdn.music.apple.com, API/playback
//    endpoints below, artwork on is1-ssl.mzstatic.com.
// Artwork img-src stays an allowlist on purpose (the server will later restrict
// artwork hosts to the same set).

export const CSP_DIRECTIVES: Record<string, readonly string[]> = {
  'default-src': ["'self'"],
  // TODO: 'unsafe-inline' is required by Next.js inline bootstrap scripts.
  // Replace with a per-request nonce policy (separate, larger change).
  'script-src': [
    "'self'",
    "'unsafe-inline'",
    'https://www.youtube.com',
    'https://sdk.scdn.co',
    'https://js-cdn.music.apple.com',
  ],
  'style-src': ["'self'", "'unsafe-inline'"],
  'frame-src': ['https://www.youtube.com', 'https://sdk.scdn.co'],
  'img-src': [
    "'self'",
    'data:',
    'https://is1-ssl.mzstatic.com',
    'https://i.ytimg.com',
    'https://i.scdn.co',
    'https://mosaic.scdn.co',
    'https://image-cdn-ak.spotifycdn.com',
    'https://image-cdn-fa.spotifycdn.com',
    'https://e-cdns-images.dzcdn.net',
  ],
  'connect-src': [
    "'self'",
    'https://accounts.spotify.com',
    'https://api.spotify.com',
    'https://*.supabase.co',
    'https://api.music.apple.com',
    'https://play.itunes.apple.com',
    'https://buy.itunes.apple.com',
  ],
  // MusicKit feeds decrypted HLS segments to the media element through MSE.
  'media-src': ["'self'", 'blob:'],
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
