# Identity decisions (#325)

Status: accepted. Date: 2026-10-07 (every decision below was made that day, in one owner session). Summary of the resulting rules: [`DESIGN.md`](../../DESIGN.md).

This lives in `docs/design/` and not `docs/adr/` because `docs/adr/` is gitignored (#256).

## Context

Issue #325 asked to review CoJam's visual identity. Two brand rounds failed because they skipped step 0: the "Two Listeners" mark was already final (2026-07-17) and both rounds proposed new marks and new genres on top of it. Out-of-genre sources imported their genre instead of a treatment. The owner's decisions then lived only in gitignored files (`.claude/design/`) and agent memory. This record commits them.

Provenance: every quote below was said directly by the owner in chat on 2026-10-07, not relayed by another agent. Spelling is kept as typed (including typos).

## Decision

### 1. The mark stays, then N3 is picked and approved

- Mark stays. Owner answer to the question "Confirma, marca fica", chosen option: "Confirma, marca fica (Recomendado)". Decision: the Two Listeners mark (shape, violet frame, green core) is kept; "logo" in #325 means wordmark, app icon and share image. Mark-execution variants stay off the table unless the owner reopens.
- Logo refinement: on seeing coloured logo variations, "Essas variações coloridas da logo ficaram HORRIVEIS". Rule: refinement is shape only, colour stays as in `Logo.tsx`, never recolour.
- Shape rounds: "o C foi o que feicou melhor, mas ainda não ta profissional." C was a headphone band plus cups with a solid green disc and cut-out bars.
- N3 picked: "Uma mustira do hoje com o C anterior", then "entre o M1 e o M3", then "N3". N3 is the outer bean cups of "Hoje", the thick band of C (no top dot), and a solid green disc with Hoje's sine wave knocked out.
- Kit approved: "aprovado".
- PRs: #339 (N3 mark), #340 (header uses the small cut at <= 32px; owner: "corrige o logo do header pra versão pequena" then "mergeia"). #330 fixed the share image to draw the real mark.

### 2. Brand rounds 1 and 2 rejected

- Round 1 (Rolê, Sala, Rádio; in-category genre archetypes): "Muito generico."
- Round 2 (Fase, Letreiro, Nave; from concrete poetry, Amazon boat lettering, Belém aparelhagem): "Ficou ainda pior do que as referencias de antes."
- Root cause: both replaced owner-decided identity. Genre stays "social hangout app".
- Round 3 brand bugs, approved to fix first in one PR: the share image drew a rejected green dot and "COJAM", green sat on action links, room strings were in English, `--color-ident-3` was green. PR: #330.

### 3. Recognition board: Stationhead, Apple Music, Spotify

After two consecutive rejections of motion studies ("A + B parece legal", then "o C foi o que feicou melhor também só que ainda muito ruim."), the owner answered a board of real products by number:

> "9 é bem legal. 05 é bom também, o 06 é um classico que funciona"

09 Stationhead sets structure, 05 Apple Music the colour mechanism, 06 Spotify the one-colour-per-track idea. Board and notes: `.claude/design/reference-board-cojam-cor-da-faixa.md` (local only).

### 4. Axes: sala toda, chat na cor, celular inclinado

Said together with the motion request (decision 5): "sala toda, chat na cor, celular inclinado." Meaning: tint on the whole room, chat on the tint, tilted phone on the landing. Superseded in part by sintonia (decision 9): the final ground replaced the per-axis tinting and the phone tilt hook was removed in #341.

### 5. Motion request

Same message: "Também precisamos pensar em algumas animações com /gsap-scrolltrigger e three.js pra trazer dinamismo". GSAP shipped (scroll story, section waves, cover flip). three.js was built, then dropped when sintonia was chosen (#341 removed the dependency).

### 6. Flat ground rejected

Earlier, on the flat Vercel-style preview: "O design proposto está muito flat e minimalista, isso acaba caindo na tendencia de TODAS aplicações atualmente que seguem a linha da vercel, eu queria algo mais dinamico, algo diferente"

On the single-tint motion preview: "Ficou legal, mas esse fundo chapado não sei se passa a vibe de musica, de conexão que queremos passar"

### 7. Conexao ground: "too much"

Of the three grounds tried (capa, malha, conexao) the owner wanted something like malha plus conexao, full quote: "Eu queria algo parecido com o malha + conexão só que do jeito que está eu acho too much e não tem muita consistência e coerência". Direction given: one ground, one connection element, one surface, strict colour roles, at most 2 moving things at rest.

### 8. Sintonia approved

Owner: "ok, transforma a prévia em PR". The approved sintonia: one page-wide ground of two cover colours, one wave connection, one glass surface, no three.js. The five rules are in `DESIGN.md`. PR: #341. #343 (img-src for all cover hosts) keeps the cover colour readable from Deezer and other sources. #342 and #344 are playback fixes from the same session, not design.

### 9. Join screen

"Precisamos também atualizar a tela de entrar na sala que não está coerente com o resto". Follow-up on the cover: "A imagem do album pode estar alinhada verticalmente com o título do ábum". Shipped inside #341.

### 10. Other screens

"ok, corrige o bug da Fila e passa as outras telas". 404, /account (now PT-BR), /rooms, the Spotify callback, the removed-from-room screen and the age gate move to the same ground (`SintoniaScreen`, idle violet when nothing plays). Shipped inside #341.

### 11. Queue: "social" picked

"a fila está com um visual muito genérico de IA", then "espera o autoplay, e social na fila". The owner chose the `social` variant out of lista, social and capas: who asked, voter avatars, current track pinned on the cover tint. Needs the member user id on presence so voters resolve. Branch `feat/fila-social`; no PR open when this was written. #338 earlier fixed the queue and activity overlap.

### 12. Room: round 4, "1 definitivamente" (2026-10-08)

Every quote below is from 2026-10-08. After the sintonia room (decisions 8 and 11) the owner asked for a different room and rejected three hand-coded rounds in a row.

- On the sintonia room, "Ainda muito genérico, pareia o identity-studio com o debate".
- On debate directions A and B: "Nenhum dos dois".
- On a recognition board of App Store screenshots: "perto 1, 8 e 9, longe 7, 9". The owner then clarified 9 with "Só perto". So near: 1 Airbuds, 8 Stationhead, 9 Spotify. Far: 7 Gartic Phone.
- On the solid-block round: "Ficou esquisito, muito mobile, muito chapado".
- On 6 image-model mockups: "1 definitivamente". That image is the anchor, kept at `.claude/design/refs/r4-mockup-1-approved.png` (local only).

Decision: the room is a polished desktop app, near-black ground with soft violet ambient light (not the cover colour), three columns (now playing and listeners, queue, chat), solid dark panels with a hairline and a violet glow only on the now-playing card. The cover-colour ground stays on the landing and other screens until the owner decides on them; that is a follow-up.

## Consequences

- The mark, violet actions, green LIVE, the two fonts and PT-BR are fixed base. Future rounds recombine execution inside sintonia, not the base.
- Cover colour is ground only; this constrains every new surface (`DESIGN.md`, "Add a new surface").
- `scripts/check_web_drift.sh` enforces green-for-LIVE and the Tailwind palette in CI; the other rules rely on review.
- Motion has a hard budget and a reduced-motion state; the landing's one-second re-render makes effect dependency stability a standing risk.
- Open at time of writing: the live room with a playing track was eyeballed by the owner (room OK) but the queue redesign is unmerged.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| New mark in rounds 1 and 2, genre archetypes, art-project sources | "muito genérico", "ficou ainda pior"; logo was already final |
| Flat, minimal, Vercel-style, or stripped aurora only | "muito flat e minimalista"; owner wants dynamic |
| Coloured logo variants | "ficaram HORRÍVEIS" |
| Abstract motion study C without a real room | "ainda muito ruim" |
| Flat single-tint ground | "fundo chapado" does not read as music or connection |
| Capa, malha and conexao grounds, mesh with listener rings | "too much", inconsistent |
| three.js ground | Dropped with sintonia; no dependency |
| Aurora, glass-with-blur, glow decoration | Generic; listed as exclusions from round 3 |
