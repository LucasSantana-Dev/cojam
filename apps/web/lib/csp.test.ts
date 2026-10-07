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

  it('never uses a bare wildcard source and only the documented Supabase subdomain wildcard', () => {
    const wildcards = Object.values(CSP_DIRECTIVES)
      .flat()
      .filter((s) => s.includes('*'));
    expect(wildcards).toEqual(['https://*.supabase.co']);
    for (const sources of Object.values(csp)) {
      expect(sources).not.toContain('*');
      expect(sources).not.toContain('https:');
      expect(sources).not.toContain('http:');
    }
  });
});
