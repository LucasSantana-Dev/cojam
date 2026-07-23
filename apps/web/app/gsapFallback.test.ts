// @vitest-environment node
// Node env: this suite reads globals.css via `new URL(..., import.meta.url)`;
// under jsdom the module URL is not a file: URL, so readFileSync rejects it
// (ERR_INVALID_URL_SCHEME).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Contract for the GSAP-failure fallback on the landing page: when the gsap
// dynamic import fails, page.tsx adds .no-gsap to <html>, and this CSS rule
// is the only thing that makes .reveal sections visible (base: opacity 0).
describe('no-gsap reveal fallback', () => {
  const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');

  it('keeps .reveal hidden by default (the failure mode this guards)', () => {
    const base = css.match(/^\.reveal\s*\{([^}]*)\}/m);
    expect(base?.[1]).toContain('opacity: 0');
  });

  it('forces .reveal visible under .no-gsap', () => {
    const rule = css.match(/\.no-gsap\s+\.reveal\s*\{([^}]*)\}/);
    expect(rule?.[1]).toContain('opacity: 1');
    expect(rule?.[1]).toContain('transform: none');
  });
});
