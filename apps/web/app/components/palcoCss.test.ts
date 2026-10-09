import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PALCO_PAGE_CSS, PALCO_TOKENS } from './palcoCss';

// The palco tokens exist twice on purpose: in globals.css (`.palco`, the room) and
// in palcoCss.ts (so global-error.tsx works without globals.css). Pin them together.
describe('palco page css', () => {
  const globals = readFileSync(path.resolve(__dirname, '../globals.css'), 'utf8');
  const block = globals.slice(globals.indexOf('\n.palco {'), globals.indexOf('.palco__main'));

  it.each([
    ['ink', '--palco-ink'],
    ['plate', '--palco-plate'],
    ['line', '--palco-line'],
    ['text', '--palco-text'],
    ['you', '--palco-you'],
  ] as const)('token %s matches globals.css', (key, cssVar) => {
    expect(block).toContain(`${cssVar}: ${PALCO_TOKENS[key]};`);
  });

  it('uses no Inter, Roboto or Arial and no dashes', () => {
    expect(PALCO_PAGE_CSS).not.toMatch(/\binter\b|roboto|arial/i);
    expect(PALCO_PAGE_CSS).not.toMatch(/[\u2013\u2014]/);
  });

  it('has no animation, blur or glow', () => {
    expect(PALCO_PAGE_CSS).not.toMatch(/animation|@keyframes|blur\(|backdrop-filter|glow/);
  });
});
