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
  /^#0{3,8}$/, //                 mask-image stencil: an alpha channel, not a colour
  /^rgba?\(\s*0[\s,]+0[\s,]+0/, // pure-black scrim, either rgb syntax
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
 * Every CSS hex length (3, 4, 6, 8) and both rgb syntaxes, legacy comma-separated
 * and modern space-separated with slash alpha.
 */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([\d\s,.%/]+\)/g;

/**
 * Issue references like `#287` are hex-valid and appear in test names and JSX
 * prose, which comment stripping does not reach. They are always decimal, so a
 * short all-decimal match is ambiguous and skipped. The cost is a 3 or 4 digit
 * numeric grey such as `#111`; the codebase has none, and `#000` is exempt
 * anyway. Six and eight digit matches are never skipped: no issue number is
 * that long.
 */
function isIssueReference(match: string): boolean {
  const digits = match.slice(1);
  return digits.length <= 4 && /^\d+$/.test(digits);
}

/** Lengths CSS actually accepts. `#12345` is neither a colour nor an issue. */
function isValidHexLength(match: string): boolean {
  return [3, 4, 6, 8].includes(match.length - 1);
}

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
          if (match.startsWith('#') && (isIssueReference(match) || !isValidHexLength(match))) {
            continue;
          }
          offenders.push(`${rel}:${i + 1}  ${match.trim()}`);
        }
      });
  }

  it('has no hex or rgb colour outside the exemption list', () => {
    expect(offenders).toEqual([]);
  });

  it.each([
    ['#fff', true],
    ['#ffff', true],
    ['#ffffff', true],
    ['#ffffffff', true],
    ['#4ade80', true],
    ['rgb(255, 0, 0)', true],
    ['rgba(255,0,0,0.5)', true],
    ['rgb(255 0 0)', true],
    ['rgb(255 0 0 / 50%)', true],
    ['rgba(255 0 0 / 50%)', true],
    ['rgb(100% 0% 0% / 50%)', true],
    ['#287', false], //             issue reference
    ['#1234', false], //            issue reference
    ['#12345', false], //           not a CSS hex length
    ['#000', false], //             mask stencil, exempt
    ['rgba(0, 0, 0, 0.5)', false], // scrim, exempt
    ['rgb(0 0 0 / 50%)', false], //  scrim, modern syntax
    ['oklch(0.8 0.18 152)', false],
  ])('matcher on %s -> flagged: %s', (input, expected) => {
    const flagged = (input.match(COLOR_LITERAL) ?? []).some(
      (m) =>
        !EXEMPT_VALUES.some((p) => p.test(m)) &&
        !(m.startsWith('#') && (isIssueReference(m) || !isValidHexLength(m))),
    );
    expect(flagged).toBe(expected);
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
