# CoJam design language

Read this before touching any UI. It is the committed source for the identity: the owner's decisions are in [`docs/design/identity-decisions.md`](docs/design/identity-decisions.md), the code that implements them is named in each section. If code and this file disagree, fix one of them in the same PR.

## Identity

**Source: the product idea.** CoJam lets friends on different streaming services listen together in one room, each playing on their own account, kept in sync through metadata only. The identity has to say "we are listening to the same thing, right now, from different places". Genre: social hangout app. Not an art project, not a developer tool.

**Theme: sintonia (being in tune).** The colour of the track on stage becomes the ground of the product, and one thin line links the listeners. Three anchors, picked by the owner from a recognition board of real products:

| Anchor | Governs |
|---|---|
| 09 Stationhead | Structure: host on top, now-playing stage in the centre, live chat. The room reads as an on-air stage. |
| 05 Apple Music | Colour mechanism: full-bleed colour from the cover, white controls and type on it. |
| 06 Spotify | One solid colour per track, heavy white type on it. |

**Signature: the sine wave.** The N3 mark knocks a sine wave out of its green disc. The same wave, as one thin white line, links the listener avatars in the room stage and the landing phone (`ListenersWave.tsx`) and between landing sections (`SectionWave.tsx`). It is the only connection element in the product.

**The room is different (decision 12, round 4).** The live room is a polished desktop app: a near-black page lit by soft violet ambient light, three columns of solid dark panels, anchored on `.claude/design/refs/r4-mockup-1-approved.png` (owner: "1 definitivamente"). The cover colour is not its ground. Everything below about the sintonia ground, glass and cover-colour surfaces applies to the landing and every other screen; the room section ("The room") says what differs. Moving the other screens to the room's ground is an open follow-up, not decided.

**Fixed base (do not reopen without the owner):** the N3 mark, violet actions, green for LIVE only, Bricolage Grotesque plus Instrument Sans, PT-BR voice.

**Exclusions (each was rejected by the owner or by a critic):**
- Flat, minimal, Vercel-style pages ("muito flat e minimalista"). Also a flat single-colour ground.
- Coloured or recoloured logo variants.
- Art sources from outside the social-app genre (concrete poetry, boat lettering, aparelhagem).
- Aurora, glass-with-blur and glow decoration.
- three.js grounds (tried, removed in #341; the dependency is gone).

## The 5 sintonia rules

Source of truth: the block comment "Cor da faixa: sintonia" in `apps/web/app/globals.css`.

1. **One ground.** One fixed ground behind everything, the same component (`GroundStack.tsx`) on landing and every other screen (the live room has its own, see "The room"). It uses two colours of the cover (the dominant one and its nearest neighbour, at most about 60 degrees apart, `groundPair` in `lib/trackColor.ts`) drifting over 36 s and 48 s under one scrim level.
2. **Colour roles.** Cover palette is ground only. Violet is actions only. White is text. Green is LIVE only.
3. **One connection element.** The logo's sine wave, linking listener avatars, breathing on the shared beat clock (`lib/beatClock.ts`, 100 bpm, aligned by the synced room clock) while playing. Flat when paused.
4. **One surface.** Glass: black at 34%, 16% white hairline, 0.9rem radius, no blur.
5. **Motion at rest** is only ground drift and wave breathing.

## Colour roles

| Role | Colour | Rule |
|---|---|---|
| Ground | Palette taken from the cover on stage (`lib/trackColor.ts`) | Ground only. Never on buttons, links, borders or text. Idle ground is violet (`IDLE_TINT`) when nothing plays. |
| Actions and focus | Violet `oklch(0.66 0.20 300)` (`--color-accent`) | Every button, link and focus ring. |
| Text | White (off-white tokens below) | Always white on the ground. |
| LIVE | Green `--color-accent-2` and `--logo-core-*` | Only the LIVE pill, eq bars and live dots. `scripts/check_web_drift.sh` fails green outside its `LIVE_SELECTORS` allowlist and in components. |
| Success | `--color-status-ok`, violet hue | Not green: success is not LIVE. |

**Exceptions (owner approved, #325):** on the landing and the other sintonia screens, nothing outside the ground uses the cover palette. In the room (round 4) the one exception is the now-playing cover's own halo (`.r4-cover__halo`, the same image blurred behind itself, as in the anchor). The room's queue row for the playing track is a violet-tinted surface, not a cover-tinted one. Nothing else.

Off-palette Tailwind colour utilities (orange, amber, teal, and so on) in `apps/web/app/**/*.tsx` also fail the drift guard.

## Tokens

From `:root` in `apps/web/app/globals.css`. Use the token, never a literal.

| Token | Value | Role |
|---|---|---|
| `--color-surface-0` | `oklch(0.08 0 0)` | Page base, hero regions |
| `--color-surface-1` | `oklch(0.11 0.01 280)` | Deep background (remapped to glass on sintonia screens) |
| `--color-surface-2` | `oklch(0.14 0.01 280)` | Raised card |
| `--color-surface-3` | `oklch(0.18 0.01 280)` | Interactive hover |
| `--color-border` | `oklch(0.25 0.02 280)` | Subtle border |
| `--color-text-primary` | `oklch(0.96 0.01 280)` | Main text |
| `--color-text-secondary` | `oklch(0.62 0.02 280)` | Secondary text (white at 0.92 alpha on sintonia screens) |
| `--color-text-muted` | `oklch(0.48 0.01 280)` | Hints (white at 0.8 alpha on sintonia screens) |
| `--color-accent` | `oklch(0.66 0.20 300)` | Violet: actions, focus |
| `--color-accent-2` | `oklch(0.800 0.182 151.7)` | Green: LIVE only |
| `--logo-frame-from` / `-to` | `oklch(0.587 0.232 281.2)` / `oklch(0.681 0.233 311.2)` | Mark frame gradient |
| `--logo-core-from` / `-to` | `oklch(0.849 0.207 128.8)` / `oklch(0.696 0.149 162.5)` | Mark core gradient (LIVE green family) |
| `--color-status-warn` | `oklch(0.70 0.20 55)` | Reconnecting |
| `--color-status-error` / `-soft` | `oklch(0.60 0.20 25)` / `oklch(0.711 0.166 22)` | Connection lost / inline form errors |
| `--color-status-ok` | `oklch(0.871 0.09 300)` | Success text |
| `--color-ident-1` / `-2` / `-3` | `oklch(0.654 0.211 296.6)` / `oklch(0.714 0.143 254.6)` / `oklch(0.773 0.153 345)` | Member and provider identity (violet, blue, rose; never green) |
| `--glass` / `--glass-line` / `--glass-radius` | `oklch(0 0 0 / 0.34)` / `oklch(1 0 0 / 0.16)` / `0.9rem` | The one surface |
| `--dur-micro` / `-base` / `-expressive` | `160ms` / `320ms` / `640ms` | Durations |
| `--ease-out-quart` / `--ease-out-expo` | `cubic-bezier(0.25, 1, 0.5, 1)` / `cubic-bezier(0.16, 1, 0.3, 1)` | Enter easing, never linear for UI |

## Type

- Display: Bricolage Grotesque (`--font-display`). Headings, hero, brand wordmark "CoJam".
- Body: Instrument Sans (`--font-body`).
- Both load through `next/font/google` in `apps/web/app/layout.tsx`. No third webfont.

## The room (round 4)

Code: `apps/web/app/room/[id]/client.tsx`, `NowPlayingCard.tsx`, `ListenersStage.tsx`, `QueuePanel.tsx`, `ChatPanel.tsx`, `TransportUI.tsx`, and the block "Sala, round 4" at the end of `globals.css` (every selector is scoped by `.room[data-room="r4"]` or an `r4-` / `fq-` / `chat-` / `tp` class).

- **Ground:** `--r4-bg` near-black (`oklch(0.105 0.014 292)`) with three static violet radial lights (strongest top right and at the bottom) on `.room[data-room="r4"]::before`. No `GroundStack`, no cover colour, no drift.
- **Surface:** solid dark panel (`--r4-panel`), 1px hairline (`--r4-line`), `--r4-radius` 1rem, no blur, no shadow. The now-playing card alone carries a violet border glow. Panels hold type tokens remapped for the room (`--color-text-secondary` white at 0.78, muted at 0.66, both above 4.5:1 on the panel).
- **Layout:** header (N3 mark, "CoJam", divider, room name, AO VIVO pill, "N ouvindo junto", Convidar pill, own avatar), then three columns from 72rem: now playing and "Ouvindo agora" | "A seguir" queue and the add form | "Chat da Sala". Between 48rem and 72rem two columns (queue and chat stacked in the second). Under 48rem one column with the Tocando / Fila / Chat / Adicionar tabs, 44px targets.
- **Violet** is actions, focus and the vote state only: Convidar, the play button, "+ Adicionar música", thumb vote, send, host crown and "em sintonia" text. Fills that carry white text use `--r4-violet-fill` (white on it measures above 4.5:1).
- **Green** is AO VIVO only (`.r4-live`, in `LIVE_SELECTORS` of `scripts/check_web_drift.sh`). Service badges are monochrome white glyphs. Avatars are the initials avatars (`lib/avatar`), since guests have no photos.
- **Motion at rest:** one thing moves, the three sound-wave arcs above each listener avatar (and the glyph between neighbours), on the shared beat clock (`lib/beatClock`, rAF only while playing, on screen, tab visible). Static under reduced motion, paused, or alone. The queue and chat rows, the cover flight on a track change and the chat spring-in move only on events.
- **Not built because the product lacks it:** shuffle, repeat, previous and next buttons, the emoji picker in the chat input, real photos on avatars.

## Surfaces

One treatment on the landing and the other screens (the room has its own, above): `--glass` fill, `--glass-line` 1px hairline, `--glass-radius`, `backdrop-filter: none`. On sintonia screens the page tokens are remapped (`.room[data-tint="room"][data-bg="sintonia"]`, `.landing[data-bg="sintonia"]`, `.sx`) so existing components pick up the glass without per-component overrides.

## Motion

- **Budget: at most 2 moving things at rest**, ground drift and wave breathing on the landing and sintonia screens; in the room only the listener arcs. Everything else moves only on a user or scroll event.
- **Moments:** `ScrollStory.tsx` (pinned "Como funciona", GSAP ScrollTrigger, the only pinned section), `SectionWave.tsx` and `ListenersWave.tsx` (the wave), the cover flip into the stage on a track change (`useCoverFlight`, and the ground wash opening from `.np-cover`).
- **Loops** are CSS transform only, and pause when the tab is hidden or the ground is off screen.
- **Reduced motion** (`lib/motionFlags.ts`, `useMotion`): no scroll story (steps render as a grid), no flip, no drift (one static ground frame), no tint fade. The wave stays visible, already drawn. Server render and first client render are the static baseline; motion enhances after hydration.
- **Inline-deps pitfall.** The landing re-renders every second (HUD clock). A GSAP, ScrollTrigger or rAF effect keyed on an inline array or object prop rebuilds every second and drags the user's scroll (#341: pins rebuilt 21 to 51 times in 5 s). Pass module constants, key effects on `steps.length`, read changing values through refs, and verify with a probe that counts `.pin-spacer` mutations and samples `scrollY` with no input. Screenshots cannot show this. Regression test: `ScrollStory.test.tsx`.

## The mark

- **N3**: a headphone with a thick violet band and bean earcups, and a solid green disc with a sine wave knocked out of it. Geometry in `apps/web/app/components/logoMark.ts` (plain filled paths, no mask, filter or stroke), drawn by `Logo.tsx` and `opengraph-image.tsx`.
- **Colours are fixed:** violet frame gradient, green core gradient. Never recolour the mark. Logo refinement is shape only.
- **Small cut** at rendered size <= 32px (`MARK_SMALL_MAX`): thinner band, disc r58, one-period wave. Use `LogoMark`, which picks the cut from `size`.
- Master sources and the kit live in `.claude/design/logo/kit/` (local only, gitignored). The overview image is `overview-kit.png` there.

## Contrast

White text on the ground must keep at least 4.5:1. The ground is normalised in OKLCH (lightness window `TINT_L_MIN` 0.36 to `TINT_L_MAX` 0.5, `MIN_CONTRAST` 5.6 in `lib/trackColor.ts`). Measured floor over 72 hues, 4 lightness and 3 chroma levels: 5.61:1 (max 12.11:1), per #341. Secondary and muted text are white at 0.93 to 0.97 alpha and stay above 4.5:1. Glass and scrim only darken, so text on them is at least that ratio.

## Copy

PT-BR everywhere a user can see it: room, join errors, relative times, /account, error screens. Casing "CoJam". Error messages are fixed strings that never show tokens, codes or response bodies (#342).

## Add a new surface

1. Render inside `SintoniaScreen` (non-room screens) or under `.landing` with `data-bg="sintonia"`. Do not paint your own page background. Room panels follow "The room" instead.
2. Use the glass tokens for panels. No blur, no extra shadows beyond what exists.
3. Text is white. Actions are `--color-accent`. Do not use green unless it is a LIVE indicator, and then add its selector to `LIVE_SELECTORS` in `scripts/check_web_drift.sh`.
4. Do not use the cover palette anywhere except the ground (one exception: see Colour roles).
5. Add no new loop at rest. If you add motion, gate it on `useMotion()` and give it a reduced-motion state.
6. Effects keyed on props from a re-rendering parent: stable deps only (see the pitfall above).
7. Copy in PT-BR.
8. Run `bash scripts/check_web_drift.sh`, then check the screen with a loud cover and a pale cover.
