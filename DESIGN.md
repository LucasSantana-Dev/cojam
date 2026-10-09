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
- **Layout (fidelity pass, owner: "Não está parecido"):** from 72rem a viewport-fitting app, `100dvh`, no page scroll (floor 40rem of height): top bar (N3 mark, "CoJam", divider, room name, AO VIVO pill, "N ouvindo junto", Convidar pill, own avatar with a service dot that opens the avatar menu), then three columns 1.88fr / 1.17fr / 1fr: now playing over "Ouvindo agora" (fills the rest) | "A seguir" | "Chat da Sala". The queue and the chat scroll inside their panels. There is no status bar, Atividade card, separate add card or page footer. Between 48rem and 72rem two columns; under 48rem one column with Agora / Fila / Chat tabs, 44px targets.
- **Avatar menu:** name, "Ouvindo no X" + conectado chip, Trocar nome (saves and reloads to rejoin), Trocar serviço (the same listening choice, plus the Spotify connect player, mounted while closed), Seus dados (code, Copiar, link to /privacidade#excluir-seus-dados), Minha conta, Denunciar sala, Pública (host), Privacidade / Termos, Sair da sala. Report and Pública left the top bar.
- **Now playing card:** cover left; right: kicker, title, artist, "X pediu", progress; last row: service icons under the cover (they ARE "Ouvir no", active one highlighted) and the overflow menu (Detalhes, Letra, Mais, Rádio when `radioAvailable`), transport centred (previous restarts the track, play, next), local volume as a mute button whose slider opens on hover. Unavailable, failed and empty states keep the geometry. Detalhes, Letra and Mais share one drawer slot (one open at a time, Esc, backdrop on every width).
- **Queue:** the playing track is not listed again; "+ Adicionar música" opens search inline at the top (playlist and manual add behind "Mais opções"); "Sem versão" is a muted icon with title and aria-label. The cover flight (useCoverFlight) lost its queue-row origin and no longer runs. **Chat:** system lines are one muted line, emoji button inserts from a short set, timestamps on hover.
- **Mockup over this file (owner anchor):** brand logo fills on `.svc-badge` (see Colour roles); "em sintonia" sits over the viewer's own avatar; the "conectado" chip stays neutral (green stays AO VIVO only).
- **Violet** is actions, focus and the vote state only: Convidar, the play button, "+ Adicionar música", thumb vote, send, host crown and "em sintonia" text. Fills that carry white text use `--r4-violet-fill` (white on it measures above 4.5:1).
- **Green** is AO VIVO only (`.r4-live`, in `LIVE_SELECTORS` of `scripts/check_web_drift.sh`). **Brand logo colours** (Spotify green, YouTube red) are allowed on the small service badges `.svc-badge` and nowhere else (drift rule 4). Avatars are the initials avatars (`lib/avatar`), since guests have no photos.
- **Motion at rest:** one thing moves, the three sound-wave arcs above each listener avatar (and the glyph between neighbours), on the shared beat clock (`lib/beatClock`, rAF only while playing, on screen, tab visible). Static under reduced motion, paused, or alone. The queue and chat rows, the cover flight on a track change and the chat spring-in move only on events.
- **Not built because the product lacks it:** shuffle, repeat, real photos on avatars. Dev fixture: `/room/<ID>?fixture=room|join` (non-production only, `lib/devFixture.ts`).

## Modo palco

Status: v1 in build. Part 1 (#367): the character roster and picker. Part 2: the stage view behind the "Modo palco" toggle in the top bar (remembered per browser, round 4 stays the default), with the room's own YouTube player lifted onto the screen, the booths (who queued the playing and the next track), the audience, Curtir (`reaction.woot`) and chat bubbles. Part 3: a Spotify listener sees the room's YouTube video on the screen, muted and kept in step (decision 8; the cover art when the track has no YouTube match). Reactions: a Reagir bar of six emotes (`reaction.emote`: Amei, Fogo, Rindo, Palmas, Uau, Cantando; one "Reagir" button on phones) pops a pixel bubble over the sender for about 1.5 s, never over the player, static under reduced motion; palco only. Not built yet: the listening rings. The "A seguir" board (the next up to 3 tracks, LED style) sits under the player on the stage apron, or between the floor desks on phones, and hides when the queue is empty. The palco HUD carries the volume, "Ouvir no" and, for who controls, pause and skip. Decision record and owner quotes: [`docs/design/modo-palco.md`](docs/design/modo-palco.md). References (local, gitignored, not committed): `.claude/design/refs/r5-palco-02-festival-1440.png` (anchor), `r5-palco-var-0{1..6}-*.png` (variations), `r5-palco-roster-v2.png` (roster), `r5-style-owner-avatar.png` (portrait style).

An alternative view of the live room: a pixel art stage with the YouTube video on its screen and the people in the room as the audience. It sits next to the round 4 room, not in place of it. The anchor shows a "MODO PALCO" pill in the top bar; how the user switches is for the build spec.

### The scene

Festival at night. Dark violet sky with stars and a skyline of lighting towers. A truss arch frames the screen and carries a pixel LED headphone arc (the logo's headphone). Speaker stacks flank the screen, each with a sine-wave screen (the logo's wave). Violet and lime beams fan out from the truss and the towers. The audience stands in front of the stage with silhouettes filling the back rows.

- Palette from the product: the violet of `--color-accent`, the green family of the mark, near-black from `--r4-bg`. Lime beams are scene art, not a LIVE signal; the AO VIVO pill keeps the green rule.
- One background asset plus a few animated layers (beams, wave screens, rings). No cover colour, no ground drift, no glass or blur.

### Pixel rules

- **One fixed grid.** Scene and sprites share one logical pixel size and never mix grids. Draw at the logical size, scale by an integer factor.
- **Nearest-neighbour scaling only.** `image-rendering: pixelated` on every pixel asset. No smoothing, no sub-pixel offsets, no rotated sprites.
- **Limited palette from the product.** Quantise every asset to one shared palette (the tokens above plus skin, hair and clothing ramps). No dithering inside sprites.
- The interface (top bar, name tags, bottom strip, drawers, tabs) stays in the round 4 vector language and type. It is not pixelated.

### Characters

Characters are separate from the scene, so each person picks who represents them best.

- **A fixed roster of 12.** No customisation. **Repeats are allowed**: two people may pick the same character.
- **Portrait bust** per character, in the farm-sim portrait style of the owner's GitHub avatar (three-quarter view, warm dark outline, soft shading, no dithering). Used by the picker, chat and menus.
- **Full-body sprite, front and back**, big head, in the earlier full-body style. Used in the audience. Front and back must be the same person (hair, clothes, accessories, build); a pair that does not match is rejected before it ships.
- **Picker**, shown on join and in the avatar menu. Title "Escolha quem vai pra plateia", helper "Pode repetir: outras pessoas podem escolher o mesmo". Portrait grid, one selected, keyboard operable, 44px targets, selection shown by outline plus a check, not by colour alone.
- The roster varies in age, skin tone, hair, glasses, head covering, a wheelchair user, headphones.

### The audience row

One row of sprites at the front of the stage, one per listener.

- **Name tag** above each head: dark pill with the name and the service badge (`.svc-badge`).
- **Listening rings:** the sound-wave arcs around the avatar in the member's identity colour, on the beat clock (`lib/beatClock`). Static when paused, alone or under reduced motion.
- Silhouettes behind the row are scenery, not members.
- Behaviour with many listeners (compress, wrap, scroll) is open for the build spec; whatever it is, tags never enter the screen rectangle.

### The bottom strip

A dark strip across the bottom: "TOCANDO AGORA: title · artist", the "X pediu" chip, the progress bar, and the **Fila (N)** and **Chat** buttons. Fila and Chat open as drawers that must not cover the screen.

### The YouTube screen rule

Hard rule from the YouTube API terms (see the record, section "YouTube ToS constraints").

- The screen is the **real YouTube embed**: crisp (never pixelated or filtered), **at least 200x200 CSS px** at every viewport, visible the whole time audio plays.
- **Nothing overlaps its rectangle, ever.** Not chat bubbles, placards, heads or sprites, beams or light effects, name tags (including the enlarged tags of the close camera variation), drawers, scrims or toasts.
- Bubbles, boards and effects are laid out **outside** the rectangle. The layout reserves it; it does not rely on z-order.
- Bezel and glow decoration sit outside the embed's box.
- **Non-YouTube listeners (owner: "A", 2026-10-08):** the screen shows the same YouTube video as a muted player synced to the room transport (drift correction relaxed, visuals only); their own service plays the sound. The same rules apply to it: at least 200x200, never covered. No YouTube match for the track: the screen shows the cover art.
- Several mockups broke this (bubbles over the video in variation 01, placards in 05, tags in 04). They are tone references, not layout references, for those parts.
- A layout PR states where the player sits at 390 and 1440 with each drawer and tab open, with screenshots taken with YouTube as the active source. A fixture without a player hides the violation.

### Phone layout (390)

Top to bottom: top bar, the stage (arch, screen, speakers) with the embed full width (less a 17 px gutter), 16:9 and never under 200x200, over the stage screen and the art around it (owner decision 9 in the record: the DJs stand just below it), an audience band (sprites with tags, bubbles kept outside the screen), a compact now-playing card (title, artist, "X pediu", play, progress), tabs **Palco / Fila / Chat**.

- The embed **stays mounted and visible on every tab**. Under Fila and Chat the stage shrinks to the screen plus a thin strip, never to nothing. This also removes the current phone behaviour where `.video-panel-keep` hides the player under those tabs.
- 44px targets. The audience band scrolls horizontally if it overflows.
- **Fields and the keyboard (phones):** every text field computes at least 16px (iOS Safari zooms the page on focus below that; never fix it with `maximum-scale` or `user-scalable=no`, pinch zoom stays). With the composer focused the top bar, the Palco HUD title/controls and the docked tab bar step aside so the keyboard leaves the list room; the player stays at least 200x200 and uncovered. Heights size against `--app-h` (visual viewport, set by `useVisualViewportHeight`) with `100dvh` as fallback, plus `interactive-widget=resizes-content` in the viewport export.

### Reduced motion

Under `prefers-reduced-motion` (`useMotion`): beams, wave screens, crowd and sprite loops are static frames; rings static; bubbles appear without spring-in; no camera moves. The scene reads fully as a still. At rest, motion stays inside the room's budget (rings on the beat clock, plus one decorative stage layer that pauses when the tab is hidden or the stage is off screen).

### Exclusions

- **Not Habbo**: no walking around, no rooms, no furniture, no avatar shop.
- **Not isometric.** Flat frontal stage view.
- **No chibi bodies.** Big head, believable body.
- **No front and back mismatch.** One character, one person, both views.
- No customisation beyond the fixed roster of 12.

### v1 and later

| Idea | Variation | When |
|---|---|---|
| Anchor: festival, truss, speakers, audience, bottom strip | festival (02) | v1 |
| Chat bubbles above heads, kept below the screen | var 01 | v1 |
| "A seguir" LED setlist board, outside the screen | var 01 | v1 |
| Phone layout, tabs Palco / Fila / Chat | var 06 | v1 |
| Spotlight and DJ booth | var 02 | later |
| Voting placards (re-laid out outside the screen) | var 05 | later |
| Dusk | var 03 | later |
| Close camera | var 04 | not planned (enlarged tags cover the screen) |

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
