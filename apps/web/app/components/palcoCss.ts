// CSS for the "palco on every screen" pages (home, 404, erro, and wave 2). It lives in a string
// and renders as an inline <style> so global-error.tsx, which replaces the root
// layout and so loses globals.css and the font variables, looks the same as the
// rest. Tokens mirror the `.palco` block in globals.css (palcoCss.test.ts pins it).
// Home-only rules (.pwh-*) stay in globals.css.

export const PALCO_TOKENS = {
  ink: 'oklch(0.14 0.03 292)',
  plate: 'oklch(0.16 0.035 292 / 0.94)',
  line: 'oklch(0.86 0.06 292 / 0.28)',
  text: 'oklch(0.96 0.015 292)',
  you: 'oklch(0.89 0.2 128)',
} as const;

export const PALCO_PAGE_CSS = `
.pw {
  --palco-ink: ${PALCO_TOKENS.ink};
  --palco-plate: ${PALCO_TOKENS.plate};
  --palco-line: ${PALCO_TOKENS.line};
  --palco-text: ${PALCO_TOKENS.text};
  --palco-you: ${PALCO_TOKENS.you};
  --pw-muted: oklch(0.84 0.03 292);
  --pw-violet: oklch(0.54 0.215 298);
  --pw-violet-edge: oklch(0.36 0.16 298);
  --pw-violet-text: oklch(0.8 0.13 300);
  --pw-radius: 6px;
  --pw-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  position: relative;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow-x: clip;
  background: var(--palco-ink);
  color: var(--palco-text);
  font-family: var(--font-body, system-ui), system-ui, sans-serif;
  line-height: 1.5;
}
.pw *, .pw *::before, .pw *::after { box-sizing: border-box; }
.pw :where(h1, h2, h3, p, ul, ol) { margin: 0; }
.pw :where(ul, ol) { padding: 0; list-style: none; }
.pw a { color: inherit; text-decoration: none; }
.pw :focus-visible { outline: 2px solid var(--pw-violet-text); outline-offset: 2px; }

.pw-bar {
  position: relative;
  z-index: 2;
  width: 100%;
  max-width: 90rem;
  margin-inline: auto;
  padding: 0.75rem 1rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem 1.5rem;
}
.pw-bar--over { position: absolute; top: 0; left: 0; right: 0; }
/* A top ink scrim, so the wordmark and the nav stay readable over bright truss and lights. */
.pw-bar--over::before {
  content: "";
  position: absolute;
  z-index: -1;
  top: 0;
  bottom: -1.5rem;
  left: 50%;
  width: 100vw;
  transform: translateX(-50%);
  background: linear-gradient(to bottom, oklch(0.14 0.03 292 / 0.86), oklch(0.14 0.03 292 / 0));
  pointer-events: none;
}
.pw-nav { display: flex; align-items: center; gap: 0.5rem 1.5rem; margin-left: auto; }
.pw-nav__link {
  display: none;
  align-items: center;
  min-height: 2.75rem;
  font-size: 1.0625rem;
  font-weight: 600;
  color: var(--palco-text);
}
.pw-nav__link:hover { text-decoration: underline; text-underline-offset: 0.3em; }
.pw-nav__link[aria-current="page"] { text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 0.3em; }
@media (min-width: 48rem) { .pw-nav__link { display: inline-flex; } }
.pw-brand { display: inline-flex; align-items: center; gap: 0.6rem; min-height: 2.75rem; }
.pw-brand__word {
  font-family: var(--font-display, system-ui), system-ui, sans-serif;
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.pw-plate {
  background: var(--palco-plate);
  border: 1px solid var(--palco-line);
  border-radius: var(--pw-radius);
}
.pw-eyebrow {
  font-family: var(--pw-mono);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--pw-violet-text);
}
.pw-title {
  font-family: var(--font-display, system-ui), system-ui, sans-serif;
  font-size: clamp(1.75rem, 1.2rem + 2vw, 2.5rem);
  font-weight: 700;
  line-height: 1.08;
  letter-spacing: -0.025em;
}
.pw-text { color: var(--pw-muted); font-size: 1rem; line-height: 1.5; }

.pw-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2.75rem;
  padding: 0 1.25rem;
  border: 0;
  border-radius: var(--pw-radius);
  background: var(--pw-violet);
  box-shadow: 0 2px 0 var(--pw-violet-edge);
  color: oklch(0.99 0.004 292);
  font: inherit;
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.2;
  white-space: nowrap;
  cursor: pointer;
}
.pw-btn:hover:not(:disabled) { background: oklch(0.58 0.215 298); }
.pw-btn:active:not(:disabled) { transform: translateY(1px); box-shadow: 0 1px 0 var(--pw-violet-edge); }
.pw-btn:disabled { cursor: not-allowed; opacity: 0.55; box-shadow: none; }
.pw-btn--quiet {
  background: oklch(0.21 0.03 292);
  border: 1px solid var(--palco-line);
  box-shadow: 0 2px 0 oklch(0.09 0.02 292);
}
.pw-btn--quiet:hover:not(:disabled) { background: oklch(0.25 0.035 292); }
.pw-btn--quiet:active:not(:disabled) { box-shadow: 0 1px 0 oklch(0.09 0.02 292); }

/* Fields on a plate: a label, an input, a pressed-state choice, a segmented control. */
.pw-label { display: block; font-size: 0.9375rem; font-weight: 600; color: var(--palco-text); }
.pw-input {
  width: 100%;
  min-height: 2.75rem;
  padding: 0 0.875rem;
  border: 1px solid var(--palco-line);
  border-radius: var(--pw-radius);
  background: oklch(0.1 0.025 292);
  color: var(--palco-text);
  font: inherit;
  font-size: 1rem;
}
.pw-input::placeholder { color: oklch(0.72 0.03 292); }
.pw-input:focus { border-color: var(--pw-violet-text); }
.pw-choice {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  min-height: 2.75rem;
  padding: 0 0.875rem;
  border: 1px solid var(--palco-line);
  border-radius: var(--pw-radius);
  background: oklch(0.21 0.03 292);
  box-shadow: 0 2px 0 oklch(0.09 0.02 292);
  color: var(--palco-text);
  font: inherit;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
}
.pw-choice:hover { background: oklch(0.25 0.035 292); }
.pw-choice[aria-pressed="true"] { border-color: var(--pw-violet-text); box-shadow: 0 0 0 1px var(--pw-violet-text); }
.pw-seg { display: inline-flex; padding: 3px; gap: 3px; border: 1px solid var(--palco-line); border-radius: var(--pw-radius); background: var(--palco-plate); }
.pw-seg button {
  min-height: 2.5rem;
  padding: 0 1rem;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--palco-text);
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}
.pw-seg button[aria-pressed="true"] { background: var(--pw-violet); box-shadow: 0 2px 0 var(--pw-violet-edge); color: oklch(0.99 0.004 292); }
.pw-error { color: oklch(0.82 0.11 22); }

.pw-footer {
  width: 100%;
  max-width: 90rem;
  margin: auto auto 0;
  padding: 1.25rem 1rem 1.5rem;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem 1.5rem;
  color: var(--pw-muted);
  font-size: 0.9375rem;
}
.pw-footer a { display: inline-flex; align-items: center; min-height: 2.75rem; padding-inline: 0.15rem; }
.pw-footer a:hover { color: var(--palco-text); }
.pw-footer__mark { display: inline-flex; align-items: center; gap: 0.5rem; }
@media (min-width: 48rem) { .pw-footer { padding-inline: 3.5rem; } }
.pw-dock {
  position: relative;
  z-index: 1;
  width: calc(100% - 2rem);
  max-width: 78rem;
  margin: 1.25rem auto 0.5rem;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.pw-dock .pw-title { font-size: clamp(1.625rem, 1.3rem + 1vw, 2rem); }
.pw-dock__copy { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.pw-actions { display: flex; flex-direction: column-reverse; gap: 0.75rem; }
.pw-actions > * { width: 100%; }
@media (min-width: 48rem) {
  .pw-bar { padding: 1rem 3.5rem; }
  .pw-dock { flex-direction: row; align-items: center; justify-content: space-between; padding: 0.875rem 1.5rem; }
  .pw-actions { flex-direction: row; flex: none; }
  .pw-actions > * { width: auto; }
}

/* Scene: native-grid art at an integer scale, DOM overlays in native coordinates. */
.pws {
  --kw: 1;
  --kp: 1;
  position: relative;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  background: var(--palco-ink);
}
@media (min-width: 60rem) { .pws { --kw: 2; } }
@media (min-width: 90rem) { .pws { --kw: 3; } }
@media (min-width: 120rem) { .pws { --kw: 4; } }
@media (min-width: 390px) { .pws { --kp: 2; } }
@media (min-width: 585px) { .pws { --kp: 3; } }
.pws__art { width: 100%; display: flex; justify-content: center; }
.pws__v { display: none; position: relative; flex: none; width: calc(var(--k) * var(--nw) * 1px); height: calc(var(--k) * var(--nh) * 1px); }
.pws__v--phone { --k: var(--kp); display: block; }
.pws__v--wide { --k: var(--kw); }
@media (min-width: 48rem) {
  .pws__v--phone { display: none; }
  .pws__v--wide { display: block; }
}
.pws__img { display: block; width: 100%; height: 100%; max-width: none; image-rendering: pixelated; }
.pws-at { position: absolute; left: calc(var(--k) * var(--x) * 1px); top: calc(var(--k) * var(--y) * 1px); pointer-events: none; }
.pws-at--up { transform: translate(-50%, calc(-100% - 3px)); }
.pws-at--upleft { transform: translate(0, calc(-100% - 4px)); }
.pws-at--below { transform: translate(0, 4px); }
.pws-at--feet { transform: translate(-50%, -100%); }
.pws-sprite { display: block; width: calc(var(--k) * 20px); height: calc(var(--k) * 48px); max-width: none; image-rendering: pixelated; }
.pws-led { position: absolute; left: calc(var(--k) * var(--x) * 1px); top: calc(var(--k) * var(--y) * 1px); width: calc(var(--k) * var(--w) * 1px); height: calc(var(--k) * var(--h) * 1px); display: block; shape-rendering: crispEdges; pointer-events: none; }
.pws-led__t, .pws-led__s--white { fill: oklch(0.95 0.02 292); }
.pws-led__s--violet { fill: oklch(0.74 0.15 295); }
.pws-stack { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.pws-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--palco-plate);
  border: 1px solid var(--palco-line);
  color: var(--palco-text);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1.3;
  white-space: nowrap;
}
.pws-tag--you { background: var(--palco-you); border-color: var(--palco-you); color: oklch(0.16 0.03 292); }
.pws-bubble {
  position: relative;
  display: inline-block;
  padding: 0.375rem 0.75rem;
  margin-bottom: 4px;
  border-radius: var(--pw-radius);
  background: var(--palco-text);
  box-shadow: 0 2px 0 oklch(0.1 0.02 292);
  color: oklch(0.16 0.03 292);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
}
.pws-bubble::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: -6px;
  margin-left: -6px;
  border: 6px solid transparent;
  border-bottom: 0;
  border-top-color: var(--palco-text);
}
`;
