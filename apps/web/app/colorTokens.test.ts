import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Guards the OKLCH design system against hex and rgb escapes (#287).
 *
 * The system is OKLCH by decision so that a hover state is a lightness step and
 * a disabled state is a chroma reduction, both on one hue. A literal cannot be
 * adjusted that way, so each escape forces hand-tuning and the palette drifts.
 *
 * Rationale, measurements and the exception list live in
 * docs/specs/287-oklch-color-discipline.md.
 */

const APP = path.resolve(__dirname, '..');

/** Files with no access to the cascade, so a literal is correct there. */
const EXEMPT_FILES = new Set([
  'app/layout.tsx', //            themeColor is browser metadata, parsed outside CSS
  'app/opengraph-image.tsx', //   Satori renders at the edge: no cascade, no vars
  'app/global-error.tsx', //      runs after a crash, possibly before CSS loads
  'app/colorTokens.test.ts', //   this file names the colours it forbids
]);

/** Literals that are not colours, or are neutral with no hue to manipulate. */
const EXEMPT_VALUES = [
  /#000\b/, //                    mask-image stencil: an alpha channel, not a colour
  /rgba?\(0,\s*0,\s*0/, //        pure-black scrim
];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, acc);
    else if (/\.(tsx?|css)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

/** Strips comments so an issue reference like `#290` is not read as a colour. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Six or eight digits only. Three-digit shorthand overlaps issue references
 * like `#287`, which are hex-valid and appear throughout the source; the
 * codebase has no 3-digit colours outside the exempt mask stencils.
 */
const COLOR_LITERAL = /#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b|rgba?\([\d\s,.%]+\)/g;

describe('OKLCH colour discipline (#287)', () => {
  const offenders: string[] = [];

  for (const file of sourceFiles(APP)) {
    const rel = path.relative(APP, file);
    if (EXEMPT_FILES.has(rel)) continue;

    stripComments(readFileSync(file, 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        for (const match of line.match(COLOR_LITERAL) ?? []) {
          if (EXEMPT_VALUES.some((p) => p.test(match))) continue;
          offenders.push(`${rel}:${i + 1}  ${match.trim()}`);
        }
      });
  }

  it('has no hex or rgb colour outside the exemption list', () => {
    expect(offenders).toEqual([]);
  });

  it('declares every colour token in oklch()', () => {
    const root = readFileSync(path.join(APP, 'app/globals.css'), 'utf8')
      .match(/^:root \{[\s\S]*?^\}/m)?.[0];
    expect(root).toBeDefined();

    const nonOklch = stripComments(root!)
      .split('\n')
      .filter((l) => /^\s*--(color|logo)-/.test(l))
      .filter((l) => !l.includes('oklch('));

    expect(nonOklch).toEqual([]);
  });
});
