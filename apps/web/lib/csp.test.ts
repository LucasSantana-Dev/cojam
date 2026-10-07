import { describe, expect, it } from 'vitest';
import { buildCsp, CSP_DIRECTIVES } from './csp';

function parse(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp.split('; ').map((d) => {
      const [name, ...sources] = d.split(' ');
      return [name, sources];
    }),
  );
}

describe('production CSP', () => {
  const csp = parse(buildCsp());

  it.each([
    ['script-src', 'https://www.youtube.com'],
    ['script-src', 'https://sdk.scdn.co'],
    ['script-src', 'https://js-cdn.music.apple.com'],
    ['frame-src', 'https://www.youtube.com'],
    ['frame-src', 'https://sdk.scdn.co'],
    ['connect-src', 'https://api.spotify.com'],
    ['connect-src', 'https://accounts.spotify.com'],
    ['connect-src', 'https://api.music.apple.com'],
    ['img-src', 'https://i.ytimg.com'],
    ['img-src', 'https://i.scdn.co'],
    ['img-src', 'https://is1-ssl.mzstatic.com'],
    ['img-src', 'https://*.dzcdn.net'],
    ['img-src', 'https://*.mzstatic.com'],
    ['img-src', 'https://*.scdn.co'],
    ['img-src', 'https://*.spotifycdn.com'],
    ['img-src', 'https://*.ytimg.com'],
    ['media-src', 'blob:'],
  ])('%s allows %s', (directive, origin) => {
    expect(csp[directive]).toContain(origin);
  });

  it('keeps the strict anti-framing and injection directives', () => {
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'self'"]);
    expect(csp['form-action']).toEqual(["'self'"]);
    expect(csp['default-src']).toEqual(["'self'"]);
  });

  // CSP host-source matching: https://*.x.y matches any subdomain of x.y.
  const imgAllows = (host: string) =>
    csp['img-src'].some((s) => s === `https://${host}` || (s.startsWith('https://*.') && host.endsWith(s.slice('https://*'.length))));

  it.each([
    'cdn-images.dzcdn.net',
    'e-cdns-images.dzcdn.net',
    'is3-ssl.mzstatic.com',
    'image-cdn-fa.spotifycdn.com',
    'i9.ytimg.com',
    'i.scdn.co',
    'mosaic.scdn.co',
  ])('img-src allows cover host %s', (host) => {
    expect(imgAllows(host)).toBe(true);
  });

  it('img-src has no bare wildcard and no http: source', () => {
    expect(csp['img-src']).not.toContain('*');
    expect(csp['img-src'].some((s) => s.startsWith('http:'))).toBe(false);
  });

  it('never uses a bare wildcard source and only documented vendor subdomain wildcards', () => {
    const wildcards = Object.values(CSP_DIRECTIVES)
      .flat()
      .filter((s) => s.includes('*'));
    expect(wildcards.sort()).toEqual(
      [
        'https://*.dzcdn.net',
        'https://*.mzstatic.com',
        'https://*.scdn.co',
        'https://*.spotifycdn.com',
        'https://*.supabase.co',
        'https://*.ytimg.com',
      ].sort(),
    );
    for (const sources of Object.values(csp)) {
      expect(sources).not.toContain('*');
      expect(sources).not.toContain('https:');
      expect(sources).not.toContain('http:');
    }
  });
});
