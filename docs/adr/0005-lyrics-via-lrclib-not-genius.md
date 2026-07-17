# ADR-0005: Lyrics via LRCLIB, not Genius scraping

**Date:** 2026-07-17
**Status:** accepted
**Context:** Audiophile Phase 1 (see the pivot decision) pairs MusicBrainz credits
(shipped, PR #20) with lyrics. The pivot memo named "Genius lyrics".

## Decision

Lyric TEXT + timestamps come from **LRCLIB** (lrclib.net). Genius is NOT used for
lyric text.

Rationale (feasibility, same class as the Tidal/AOTY/RYM rejections):

- **The Genius API does not return lyric text.** It returns song metadata,
  community annotations, and a URL to the Genius page. The lyrics are copyrighted
  and rendered on that page; obtaining them means scraping, which violates Genius
  TOS. Cojam does not ship TOS-violating scrapers (CLAUDE.md platform rules).
- **Genius has no timestamps.** The "Violet Depths" design wants SYNCED lyrics
  (current line highlighted); Genius cannot provide that.
- **LRCLIB fits exactly:** free, open, **no API key**, community database of
  `syncedLyrics` (LRC with per-line timestamps) + `plainLyrics`. `GET
  /api/get?artist_name=&track_name=&album_name=&duration=` (duration improves the
  match). No auth, generous public use. This also removes the operator-key
  blocker Phase 1 otherwise had.
- Coverage is crowd-sourced (like MusicBrainz): rich for popular tracks, sparse
  for obscure/indie. Handle a miss with a calm empty state, never an error.

## Alternatives considered

- **Genius API + scrape the page** — rejected: TOS violation, the exact mistake
  this project refuses; no timestamps anyway.
- **Musixmatch API** — has lyrics + sync but is commercial, key-gated, and
  restricts lyric display without a paid tier. Defer unless LRCLIB coverage proves
  insufficient.
- **Genius as a metadata/annotations link** — KEPT as a future, key-gated
  enhancement ("read annotations on Genius"), not a lyric-text source.

## Consequences

- Positive: legal synced + plain lyrics, zero key, ships now; consistent with the
  no-scraping principle.
- Negative: coverage gaps on obscure tracks (graceful empty state).
- Revisit if LRCLIB reliability/coverage becomes a problem (then evaluate a paid
  Musixmatch tier) or if annotations become a wanted feature (add Genius, keyed).
