# music-jam

Cross-platform group music listening app: friends on different streaming services (Spotify, Apple Music, YouTube, Tidal; Deezer/YT Music constrained, see below) listen together in shared rooms.

## Status

Greenfield (2026-07-16). No code yet. Plan: `.claude/plans/` (see latest). Research + debate findings captured in the knowledge brain under tag `project/music-jam`.

## Hard platform constraints (researched 2026-07-16, verify before relying)

- Legal model is **per-user streams synchronized by metadata** (Stationhead/Vertigo model). NEVER rebroadcast one audio stream to multiple listeners: that is the model that killed turntable.fm.
- Spotify: Web Playback SDK, Premium per user, Dev Mode capped at 5 users (Feb 2026), extended access approval required to grow.
- Apple Music: MusicKit JS, per-user subscription, JWT developer token.
- YouTube: visible IFrame embed only. No audio extraction, no background playback (TOS).
- YouTube Music: no official API. Do not integrate via ytmusicapi (cookie-based, TOS-violating).
- Deezer: API closed to new apps since ~2024. Unsupportable until reopened.
- Tidal: SDK Player exists; full catalog needs license agreement, access uncertain.
- Cross-service masters differ: ±500ms baseline offset is physics, not a bug.
- Track identity across services: ISRC (Spotify/Apple/Tidal expose it), MusicBrainz fallback, fuzzy match for YouTube.

## Brain back-link

Centralized knowledge-brain: memory pool tagged `project/music-jam` (`knowledge-brain/memory/music-jam-*.md`), graph at `knowledge-brain/graphs/music-jam/` (symlinked as `graphify-out/`).
