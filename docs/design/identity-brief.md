# Identity brief: the palco look on every screen

Started 2026-10-09. Method: identity-studio. Decision owner: Lucas (reachable).

## Owner's ask

> "Precisamos aplicar a mesma estética do palco e que estamos criando de um ambiente coletivo na home, página de erros e etc" (2026-10-09)

## Starting point: direction chosen

- **2026-10-08:** the owner asked to take the palco look to the whole app ("acho que a gente tem que explorar ela pra aplicação inteira").
- **Canvas:** https://claude.ai/artifact/4rLNVHdYRDjjvn3SFLYLpT showed A Palco inteiro, B Cena e interface and C Cartaz de festival. The owner said "Algo entre o A e o B mas não é exatamente isso", which became **D, "HUD de festival"** (local board `.claude/design/reference-board-palco-hud.md`).
- **Shipped D:** D is the language the palco shipped with (#367, #377, #378): crisp dark plates over a native-grid pixel world. On the motion prototype the owner said "Estamos na linha certa".
- **The pick:** the request above picks D for the screens outside the room. This replaces "Moving the other screens to the room's ground is an open follow-up, not decided" in DESIGN.md.
- **Stale part of the canvas:** the D boards there predate the motion verdict. Their CSS `steps()` bobs were rejected ("Essas animações ficaram horriveis"). The surfaces below use the shipped three.js scene rules instead.

## Official artifacts (in the repo)

| Artifact | Path | sha256 (12) |
|---|---|---|
| Wide stage plate 360x225 | `apps/web/public/palco/stage-360-v11.png` | 2289b00f0ffc |
| Phone stage plate 202x360 | `apps/web/public/palco/stage-phone-202-v11.png` | d0b0157dd220 |
| Sky 360x540 | `apps/web/public/palco/sky-360-v10.png` | fcfd9e120c97 |
| Sky 202x540 | `apps/web/public/palco/sky-202-v10.png` | f69943cbc1b4 |
| Crowd silhouettes (far, mid, near; a/b frames) | `apps/web/public/palco/crowd-*.png` | crowd-near-a 69445ad4cf63 |
| 13 characters: portrait 64, front/back 20x48, arms up, dances | `apps/web/public/palco/characters/` | |
| 6 emotes | `apps/web/public/palco/emotes/` | |
| N3 mark | `apps/web/app/components/logoMark.ts` | |
| World geometry (screen rects, rows, side extension) | `apps/web/lib/palco.ts` | |
| HUD tokens (`--palco-plate`, `--palco-line`, `--palco-you`) | `apps/web/app/globals.css` `.palco` | |

## Surfaces in scope

| Surface | Route / file | Today | Wave |
|---|---|---|---|
| Home | `app/page.tsx` | r4 style (`r4s-*`), room preview card | 1 |
| 404 | `app/not-found.tsx` | SintoniaScreen glass card, flat wave | 1 |
| Error | `app/error.tsx`, `app/global-error.tsx` | SintoniaScreen glass card | 1 |
| Live rooms | `app/rooms/page.tsx` | | 2 |
| Join screen | `app/room/[id]` (join state) | | 2 |
| Account | `app/account/page.tsx` | | 2 |
| Legal | `app/privacidade`, `app/termos` (`LegalPage.tsx`) | | 2 |
| Spotify callback | `app/callback/spotify/page.tsx` | | 2 |
| Share card | `app/opengraph-image.tsx` 1200x630 | | 2 |

**Out of scope:** the live room. Round 4 stays the default and palco stays its toggle (decision 12; modo-palco.md).

## Assumptions to confirm with the owner

- The fixed base holds: N3 mark, violet actions, green for AO VIVO only, lime for "you" and progress only, Bricolage plus Instrument Sans, and no third webfont. Numbers and LED boards use the monospace stack the palco HUD already ships. Pixelify Sans from the D canvas is not adopted.
- The cover-colour sintonia ground (`GroundStack`) leaves these screens. The festival at night becomes their ground.
- Every screen keeps the pixel rules: one native grid, integer scale, pixelated, nothing smoothed or rotated, HUD crisp and separate.
