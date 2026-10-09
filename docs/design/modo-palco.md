# Modo palco

Status: accepted for design, not built. Date: 2026-10-08 (every decision below was made that day, in one owner session). Resulting rules: the "Modo palco" section of [`DESIGN.md`](../../DESIGN.md).

This lives in `docs/design/` and not `docs/adr/` because `docs/adr/` is gitignored (#256), the same as [`identity-decisions.md`](identity-decisions.md).

## Context

The round 4 room is a polished desktop app of dark panels. The owner wanted a more playful view of the same room, where the video is a stage show and the people are a crowd. Quotes are in PT-BR as said by the owner in chat on 2026-10-08, spelling kept.

The idea: "O que acha de criar um modo palco onde tivesse uma ilustração em pixel art de um palco e o video estaria passando lá com a fonte do youtube e as pessoas na sala na plateia".

Constraints:

- The YouTube API terms need the embedded player visible, at least 200x200 px, and never covered or hidden while audio plays.
- Listeners are on different services (YouTube, Spotify); only the YouTube source has a video.
- CoJam stays metadata only: no audio or video is rehosted.
- The mark (headphone plus sine wave), the violet and green rules and PT-BR copy stay fixed ([`DESIGN.md`](../../DESIGN.md)).

### Alternatives shown

Four 1440 mockups (AI generated, tone references only; local `.claude/design/refs/`):

| Option | File | What it showed |
|---|---|---|
| Bar | `r5-palco-01-bar-1440.png` | A small club stage in a square panel of the three-column room, with the audience below the video; queue and chat stay beside it. |
| Festival | `r5-palco-02-festival-1440.png` | Open-air festival at night. |
| Cinema | `r5-palco-03-cinema-1440.png` | A theatre with curtains, the video on a screen and the audience in seats; queue and chat in a column on the right. |
| Card-embedded | `r5-palco-04-card-1440.png` | A small stage thumbnail in the now-playing card and a pixel crowd in the "Ouvindo agora" card of the existing room. |

The festival was also drawn at 390 (`r5-palco-05-festival-390.png`), and the card at 390 (`r5-palco-06-card-390.png`).

## Decision

### 1. The festival is the anchor

Owner: "Esse aqui ficou muito bom, vamos explorar variações desse".

Why festival over the others:

- The truss carries the logo's headphone as an LED arc and the speaker screens carry its sine wave, so the scene is the brand, not a theme laid on it.
- Open air gives a wide stage with the screen at the centre and clean space either side for boards and effects, away from the video rectangle.
- A standing crowd seen from behind reads as "people here with me" and lets each person be a distinct sprite with a tag.
- The beams use the product's violet and lime, so the palette needs no new colours.

The anchor: headphone-arc truss, a speaker stack with a sine-wave screen on each side, violet and lime beams, a front row of the room's people with name tags, service badges and listening rings, and a bottom strip with now playing, progress, Fila and Chat.

### 2. Variations

Six were drawn from the anchor: 01 setlist board plus chat bubbles, 02 spotlight plus DJ booth, 03 dusk, 04 close camera, 05 voting placards, 06 phone. Owner: "Absolutamente todos esses ficaram muito legais."

Scope (owner proposal, accepted as the working plan):

- **v1:** the anchor, chat bubbles above heads (kept below the screen), the "A seguir" LED setlist board, the phone layout.
- **Later:** spotlight and DJ booth, voting placards, dusk.
- **Not planned:** the close camera. Its enlarged name tags cover the video.

Variations 01 (bubbles), 04 (tags) and 05 (placards) were drawn over the video rectangle. The mockups are not layout references for that.

### 3. Characters are separate from the scene

Owner: "Mas acho que vamos precisar separar os personagens do ambiente pra que a pessoa escolha exatamente quem melhor representa ela, não precisa ser uma personalização absurda e pode permitir repetição".

- A fixed roster of 14 (12 at first, Mel added 2026-10-08, Nico added 2026-10-09), no customisation, repeats allowed.
- The picker shows on join and in the avatar menu: "Escolha quem vai pra plateia" and "Pode repetir: outras pessoas podem escolher o mesmo".

### 4. Style: the owner's GitHub avatar

Owner: "Olha a minha foto de perfil do github, eu queria que fosse naquela pegada". The reference (`r5-style-owner-avatar.png`) is a farm-sim portrait bust: three-quarter view, warm dark outline, soft shading, no dithering, a blue hoodie, brown hair.

### 5. Front and back must match

A first sheet was rejected: "Tem personagens que não fazem sentido, de frente é um homem e atrás uma mulher". An image model cannot guarantee a matching pair from one sheet. Process: generate each character alone (portrait, front and back in one call), quantise to the fixed grid, check that front and back match, and only then show the owner.

### 6. Portrait and body use different styles

After the style change: "O perfil ficou melhor agora, mas o boneco em si que vai aparecer eu prefiro na pegada que estava antes".

- The portrait bust (picker, chat, menus) uses the GitHub avatar style.
- The full-body sprite (audience, front and back, big head) keeps the earlier full-body style.

### 7. The roster is approved

Owner on `r5-palco-roster-v2.png`: "aprovado". Twelve characters, one per call, front and back matched for all 12. In words: a portrait row and a body row per character. Character 1 is the owner (brown hair, blue hoodie, jeans). The set covers a young woman with an afro and a red tee, a bald older man with glasses and a floral shirt, a woman in a green hijab and denim jacket, a person with long braids in a green tank, a woman with curly hair, glasses and a yellow sweater, a shaved-head man with purple headphones, a woman with a bun and a patterned dress, a man with curly hair, glasses and a grey hoodie, a person with an undercut and a striped tee, an older woman with grey curls and a beige cardigan, and a person in a cap with locs in a wheelchair.

The roster is the design baseline. Final art may be redrawn on the fixed grid; the 12 identities, and the front and back match, stay.

Names (owner approved 2026-10-08, roster order). The picker shows the name; the accessible name is "<Nome>, <descrição>".

| # | Name | Description |
|---|---|---|
| 01 | Rafa | Cabelo castanho e moletom azul |
| 02 | Jaque | Cabelo afro e camiseta vermelha |
| 03 | Seu Zé | Homem calvo de óculos e camisa florida |
| 04 | Samira | Hijab verde e jaqueta jeans |
| 05 | Luana | Tranças longas e regata verde |
| 06 | Clarice | Cabelo cacheado, óculos e suéter amarelo |
| 07 | Thiago | Cabeça raspada e fones roxos |
| 08 | Dandara | Coque e vestido estampado |
| 09 | Davi | Cabelo cacheado, óculos e moletom cinza |
| 10 | Ari | Undercut e camiseta listrada |
| 11 | Dona Cida | Cabelos grisalhos cacheados e cardigã bege |
| 12 | Biel | Boné, dreads e cadeira de rodas |
| 13 | Mel | Cachos pretos volumosos e blusa vinho |
| 14 | Nico | Cabelo loiro bagunçado e óculos cor-de-rosa |

Character 13 (Mel) joined the roster on 2026-10-08 and is pickable. The default hash still maps to 1..12 only, so nobody's default changed.

Character 14 (Nico) joined on 2026-10-09, also pickable and never a default. A real person asked to be in the roster and sent a photo; the photo stays out of git. The art is an edit of Thiago's approved sprites (07) in the Gemini app: same body, grid, shading and frames, with new hair, skin, pink glasses, nose ring, shirt print and white sneakers. The first two drafts, drawn from scratch, broke the roster pattern (big head, heavy outline) and were rejected. Owner approved the v3 set on 2026-10-09.

Dance: the audience cycles between the round 10 dance, "ombrinho" and "passinho", switching move every 8 beats on a per-person phase. Each loop is 4 frames, one per half beat. A woot still shows arms up; with motion off, idle.

### 8. Spotify and Apple Music listeners: the muted video (decided 2026-10-08)

Question: for a listener on Spotify or Apple Music, either (A) a muted synced YouTube video on the screen, or (B) the cover art. Owner answer: "A".

Update 2026-10-08: Apple Music was removed from the product (#374). The decision now applies to Spotify listeners.

- Everyone in modo palco sees the YouTube video on the screen, muted and synced, while each person listens on their own service. YouTube listeners hear it from that same player.
- Non-YouTube listeners get a muted YouTube player synced to the room transport, with drift correction relaxed (visuals only, not audio).
- If there is no YouTube match for the track, the screen falls back to the cover art.
- The ToS rules still apply to the muted player: at least 200x200 and never covered.
- Cost: two players run per Spotify listener (their service plus the muted video). CPU and battery cost on phones; revisit if measured as heavy.
- Built in part 3 (about 160 lines with tests, the Spotify audio path untouched): in palco view only, a second `YouTubePlayer` with `muted` takes the screen for a Spotify listener when the track has a YouTube match. It mutes itself, never advances the room at its end, and `lib/useVisualSync` keeps it in step every 2 s, seeking only past 3 s of drift.

### 9. Phones: a full-width player over the scene art (decided 2026-10-08)

Question: on the vertical stage the pixel screen at an integer scale is 244x144 at 390 wide, under the 200x200 the YouTube terms ask for. Either (A) a full-width 16:9 player over the stage screen, allowed to cover the scene art around it, or keep the pixel screen size. Owner answer: "A".

- On phones (the vertical stage) the player is full width less a 17 px gutter each side, 16:9, about 356x200 at 390 wide, and never under 200x200. It is centred on the stage screen and may cover the truss and the booths drawn in the art.
- Nothing covers the player: the DJs and their booth tags stand just below it, name tags and chat bubbles are pushed clear of it, and the crowd stays visible below.
- On the wide stage the player is the pixel screen (393x222 at 1440). If a small window drops the screen under 200 px tall, the player grows the same way.
- The e2e asserts at least 200x200 at 390x844 and 1440x900 with each panel open.

### 10. The named audience faces the camera; arms up follow the outfit (decided 2026-10-08)

Owner on part 2: "os personagens estão com braços gigantes, não dá pra ver o rosto deles". Two rounds of code-drawn arms were rejected ("retos como palitos, não segue a anatomia nem a roupa"); image-model frames were approved ("Ficou MUITO melhor").

- The named front row uses the front sprites (plug.dj style), so faces show. Back sprites are only for someone turned round, which nothing does yet. The background silhouettes are unchanged.
- Arms-up frames are `NN-up-front.png` and `NN-up-back.png`: 28x60, 4 px margin each side and 12 rows of headroom over the 20x48 sprite, bottom aligned. They split at row 41 (29 plus the headroom), so the legs half differs slightly where hems lift.
- Name tags rise 6 native px while the arms are up.
- This supersedes "seen from behind" in decision 1.

## Consequences

### Protocol

- A new member field for the chosen character (an id from the roster, 1 to 13), set on join and changeable from the avatar menu. Needs a default for members who never choose (guests, old clients: derive one from the member id so it is stable) and server-side validation to the roster range. Document it in [`docs/protocol.md`](../protocol.md) in the build PR. Not stored as a photo or a free string.
- The character is shown to the whole room, so it is member data like the display name. Check the privacy page wording when it ships.

### Asset pipeline

- 14 portraits plus 28 body sprites (14 front, 14 back), the stage background and its animated layers, all on one grid and one palette.
- Generation is one character per call, then quantised and checked for a front and back match before review. The generation scripts are local; the committed outputs are the final PNGs and a short note on grid size and palette.
- Assets are committed in the repo (small). The `.claude/design/refs/` mockups stay gitignored.
- Emotes are 16x16 with the shared palco palette. `emotes/uau.png` was redone on 2026-10-09: the owner judged the first one rough at 16 px. It was generated in the Gemini app with the four approved emotes and `rindo.png` as references, keeps the rindo face and changes only the expression, and was pixelized with the rindo palette. The owner picked it from a review sheet.
- Exception: `emotes/palmas.png` is 32x32 native, shown at 1x in the same 32 px box. Gemini could not draw two clapping hands on a 16 grid in four tries: it drew about 26 squares across, and downscaling to 16 lost the outline. On 2026-10-09 the owner chose the 32 px version and accepted that its pixels are half the size of the other emotes.

### YouTube ToS constraints

- The embed is real, crisp, at least 200x200, visible while audio plays, and nothing overlaps it (see `DESIGN.md`). The layout reserves the rectangle.
- Phones: the player stays mounted and visible on Palco, Fila and Chat. This also removes the current `.video-panel-keep` behaviour that hides it under Fila and Chat.
- Every layout PR states where the player sits at 390 and 1440 with each drawer and tab open, checked with YouTube as the active source. A mockup or fixture with no player hides violations.
- This repo already accepts a ToS risk for synced co-watching (local ADR-0007, accept-youtube-sync-tos-risk, in the gitignored `docs/adr/`; see also [`docs/specs/e1-video-cowatch.md`](../specs/e1-video-cowatch.md)); modo palco must not add to it.

### Other

- A second room view to test: 390 and 1440, reduced motion, each drawer, a room of 1, 6 and many listeners.
- The audience row has a size limit that is not decided yet (compress, wrap or scroll).
- The AI mockups are tone references. Pixel art in the build will differ from them.

## Revisit when

- The muted player (decision 8) measures as heavy on phones, or a ToS reading says muted video beside another service's audio is not allowed.
- A ToS reading says the stage layout (frame, bezel, effects around the embed) counts as covering or altering the player.
- The roster of 12 is not enough in use (people ask for the same missing look), or repeats confuse who is who in the audience.
- Rooms regularly pass the audience row's limit.
- The pixel scene costs frame rate on phones (the loops are the first thing to cut).
- The owner reopens the later items (spotlight, placards, dusk) or the close camera.
- The mode is picked up as a default view (today it sits next to the round 4 room, not in place of it).
