# Design references

Curated design inspiration for music-jam (dark, Spotify + Linear product-app anchor).
Gathered 2026-07-16 via a 4-stream research sweep (Dribbble, Pinterest, motion/AI
galleries, real group-listening products). Dribbble/Pinterest are auth/JS-walled, so
those pattern notes are inferred from shot metadata and cross-source commonalities.

**Anchor:** dark base, green accent (Spotify ~#1DB954 / `oklch(0.72 0.17 148)`), Linear
restraint (flat, subtle borders, generous spacing). **Rejected as off-anchor:**
neumorphism, glassmorphism/frosted glass, aqua/cyan accents, spinning vinyl, animated
waveform (also blocked — YouTube iframe audio isn't Web-Audio-accessible cross-origin).

## Patterns adopted (converged across ≥3 sources)

1. **Presence — "who's in the room"** (Spotify Jam "In this Jam", Stationhead listener
   count, Apple SharePlay circle, JQBX). Avatar stack of initials + live count. Implemented
   via centrifuge presence (server + client), rendered as a presence bar.
2. **Now-playing hero** — elevate the current track (art placeholder + large title/artist +
   source badge) instead of a caption.
3. **Attributed queue** — each track shows who added it (`{artist} by {addedBy}` + initials
   avatar). Universal across Jam/JQBX/AmpMe.
4. **Live indicator** — pulsing green dot + label; grey when disconnected.
5. **Subtle motion (CSS only, `prefers-reduced-motion`-gated)** — queue-add fade/slide,
   presence-chip fade, connection-dot breathing. No framer-motion dependency.

## Dribbble — music / collaborative / watch-party UI

- [Spotify Dark Mode UI Redesign — Desktop Concept](https://dribbble.com/shots/25974496-Spotify-Dark-Mode-UI-Redesign-Desktop-Concept) — Open T N, 2024. Sidebar + now-playing hero + queue sidebar; mini now-playing bar; queue hover states.
- [Music Collaboration Web App](https://dribbble.com/shots/24559224-Music-Collaboration-Web-App) — Ronas IT, 2024. Participant avatar stack, live indicator badge, per-track cards.
- [Gnarlist — Music Web App](https://dribbble.com/shots/11277233-Gnarlist-Music-Web-App) — New Data Services. Card-based queue, collaborative rule pills, add-to-queue inline feedback.
- [Qeue — Collaborative Playlist App](https://dribbble.com/shots/3535905-Qeue-Collaborative-Playlist-App) — Zack Kantor. Queue card with user attribution, vote/status indicators, realtime update.
- [Music Player UI concept (Dark/Light)](https://dribbble.com/shots/20554882-Music-Player-UI-concept-Dark-and-Light-Mode) — Valeria Pavlova. Full-bleed now-playing art, progress bar as anchor.
- [Music Player UI KIT (Dark Theme)](https://dribbble.com/shots/11475729-Music-Player-UI-KIT-Dark-Theme) — Julia Shagofferova. Design-system-aligned component kit, single accent.
- [Watch Party App UI/UX](https://dribbble.com/shots/17801395-Watch-Party-App-UI-UX-Design) — Giorgi Kurasbediani. Live feed + participant list + presence stack + shared-state bar.
- [Tonbar — Watch Party Platform](https://dribbble.com/shots/16917458-Tonbar-Watch-Party-Platform) — Syahrul Falah / Vektora. Status badges (live/connected), avatar stack, activity timeline.
- [Now Playing Widget](https://dribbble.com/shots/19023093-Now-Playing-Widget-Music-App) — Alexander Kremenskoy. Compact now-playing card, color from art, right-aligned metadata.
- [Music Player App](https://dribbble.com/shots/20632201-Music-Player-App) — Ronas IT. Hero art + centered controls + queue list, mono for times.

## Pinterest — dark music app UI

- [Music Player UI KIT (Dark)](https://www.pinterest.com/pin/950400327632817986/) — hierarchy on track/artist names.
- [Music Player and Menu (Dark)](https://www.pinterest.com/pin/453878468689214340/) — Riotters. Sidebar nav, centered art.
- [Dark Music Player — Aqua (Desktop)](https://www.pinterest.com/pin/dark-music-player-aqua-desktop--9570217949858172/) — desktop layout, progress indicators.
- [Music App UI Concept (Dark)](https://www.pinterest.com/pin/graphics-inspo--471470654744562520/) — Binh Nguyen. Mobile-first card reuse.
- [Audio Player Designs (30+ pins)](https://www.pinterest.com/brazzi64/audio-player-designs/) — grid/list toggle for playlists; accent range.
- [Playlist UI Collection (28)](https://www.pinterest.com/grace4453/playlist/) — user-avatar badges, duration/count badges.
- [Music Player UI Design (board)](https://www.pinterest.com/ideas/music-player-ui-design/916051500373/) — progress rings vs bars, weight hierarchy.
- *(Note: several Pinterest suggestions — neumorphism, glassmorphism, aqua — were rejected as off-anchor.)*

## Motion + AI galleries

- [Awwwards — Music Interfaces](https://www.awwwards.com/awwwards/collections/music-interfaces/) — animation/3D/data-viz driven music sites.
- [Mobbin — Music & Audio](https://mobbin.com/explore/web/app-categories/music-audio) — 1,200+ real audio-player screens, filterable by interaction.
- [Mobbin — Listening-to-audio flows](https://mobbin.com/explore/web/flows/listening-to-audio)
- [Lapa.ninja — Music](https://www.lapa.ninja/category/music/) — landing pages + free player kit.
- [Godly.design — Apps](https://godly.design/apps) — production music-app screens, dark focus.
- [Framer Marketplace — Music Player components](https://www.framer.com/marketplace/components/tags/music-player/) — code-exportable player widgets.
- [LottieFiles](https://lottiefiles.com/) — Spotify/audio/waveform Lottie animations.
- [Spotify Engineering — Animation landscape of 2023 Wrapped](https://engineering.atspotify.com/2024/01/exploring-the-animation-landscape-of-2023-wrapped) — Lottie at scale.

### Motion recipes (CSS-first, compositor-safe, `prefers-reduced-motion`-gated)

- **Queue add/reorder** — staggered fade + `translateY(50→0)`, `delay: index * 0.15s`.
- **Presence join/leave** — chip `scale(0→1)` + optional pulse ring; fade on leave.
- **Connection pulse** — `box-shadow` breathing `@keyframes pulse` on a green dot.
- **Track progress** — `conic-gradient` driven by a `--progress` CSS var updated on `timeupdate`.
- **Deferred (needs Web Audio / not viable with YouTube iframe):** frequency-bar waveform.

## Group-listening products — presence & shared-queue patterns

- [Spotify Jam](https://newsroom.spotify.com/2023-09-26/spotify-jam-personalized-collaborative-listening-session-free-premium-users/) — "In this Jam" sidebar; per-song contributor label; host reorders, guests add.
- [Stationhead](https://www.stationhead.com/) — per-station listener count badge; "Live" label; centralized now-playing manifest synced across Spotify + Apple.
- [Apple Music SharePlay (HIG)](https://developer.apple.com/design/human-interface-guidelines/shareplay/overview) — listener count in button; participants arranged in a circle, re-center on activity start.
- [Discord Living Room](https://www.frugaltesting.com/blog/discord-is-testing-a-new-living-room-layout-for-voice-channels-that-lets-users-hang-out-in-a-virtual-space) — avatar seats in a virtual room; presence without speech-first.
- [JQBX case study](https://medium.com/@jmitrano21/jqbx-fm-newcomer-integration-in-an-up-and-coming-online-community-95f4c8073f8a) — DJ turn-based queue; dope/nope passive voting; contribution badges.
- [AmpMe FAQ](https://www.ampme.com/faq) — host controls + toggled guest queue-add; emoji reactions + chat; link-share invites.
- [Vertigo (design case study)](https://www.studioherrstrom.com/work/vertigo) — "Artist Lounges" syncing Spotify + Apple + video/voice; looping wave motion for sync.

**Cross-product takeaways:** attribute every queued track; presence via avatars + a
live count beats grid tiles; combine a "Live" badge + count + progress for sync trust;
host-reorders / guests-add keeps small rooms sane.
