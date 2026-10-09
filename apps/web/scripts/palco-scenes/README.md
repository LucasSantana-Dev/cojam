# Palco scenes

Native-grid scene art for the palco screens, composed from the shipped palco art in `apps/web/public/palco/` (stage plates, sky, crowd, characters). Never redrawn.

Run: `python3 -I apps/web/scripts/palco-scenes/compose.py` (needs Pillow). Writes `apps/web/public/palco/scenes/*.png` and `apps/web/lib/palcoScenes.generated.ts`.

| Scene | Used by | Native size (wide / phone) |
|---|---|---|
| `home`, `404`, `erro` | wave 1 | 480x300 / 195x280, 480x250 / 195x240 |
| `band` | `/rooms`, `/account` | 480x130 / 195x150 |
| `band-text` | `/termos`, `/privacidade` (a little dimmer) | 480x130 / 195x150 |
| `join` | pre-join screen, with a `stand` spot for the picked character | 480x300 / 195x240 |
| `callback` | `/callback/spotify` | 480x250 / 195x240 |
| `og-1200` | `app/opengraph-image.tsx`, 400x210 native saved at x3 (1200x630) | 1200x630 |

Wave 2 screens are blank in the PNG: the page name, the room code and the Spotify state are real data, drawn in the DOM on the same 5x7 LED font (`lib/palcoLed.ts`, pinned to this script's `FONT` by `palcoLed.test.ts`) at the same integer scale. The picked character on the join floor is a DOM sprite. Only the share card has text baked in, since it is a static image.
