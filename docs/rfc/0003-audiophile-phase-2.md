# RFC-0003: Audiophile Phase 2

Status: Proposed (wave 1 authorized; later waves gated)
Pipeline: ralphinho-rfc-pipeline
Complements: RFC-0002 (synchronized playback), ADR-0005 (lyrics via LRCLIB)

## 1. RFC intake

### Problem
Phase 1 shipped credits (MusicBrainz) + lyrics (LRCLIB), but the lyrics panel is
static (no current-line highlight) and there is no listen/tag enrichment. Phase 2
makes the listening experience feel audiophile: the lyrics follow along, and
tracks carry richer metadata (listen counts, tags) from ListenBrainz and Last.fm.

### Goals
- Active-line lyric highlight that follows playback, with auto-scroll.
- ListenBrainz enrichment (listen counts, tags) behind its own flag.
- Last.fm enrichment (playcount, top tags) code-complete but dark until enabled.
- Every piece flag-gated and gracefully degrading (a missing provider never
  breaks the room), matching the Phase 1 provider seams.

### Non-goals
- Scrobbling to a user's own Last.fm/ListenBrainz account (needs per-user OAuth).
- Replacing MusicBrainz track-depth; ListenBrainz/Last.fm are additive.

### Decision: reuse the Phase 1 provider seam; drive the highlight off local position
Enrichment providers mirror `TrackDepthProvider` exactly (func-type + `WithX` +
dispatch case with 10s timeout + nil-check + error-return-empty + `httpx` +
`ErrNotConfigured` + `FEATURE_*` flag). The lyric highlight uses the LOCAL
player's position (`IPlayer.getCurrentPositionMs` / `onPositionChanged`, from
RFC-0002 U2), NOT the synchronized transport, so it works for solo listening
regardless of `FEATURE_SYNC`; when sync is on, clients are already position-synced
so they highlight the same line for free.

### Revisit when
Per-user scrobbling is wanted (needs OAuth per service), or a provider's free-tier
terms change (Last.fm enrichment is enable-gated on a commercial LOI).

## 2. DAG decomposition

```
  U1 (lyric highlight)        U2 (ListenBrainz provider)
        (web, LOI-free)              (server, LOI-free)
                                          |
  U3 (Last.fm enrich)                     |
   (server, code now, ENABLE on LOI)      |
                          \               |
                           `----> U4 (enrichment panel, web)
```

- **Wave 1 (parallel):** U1 and U2 are independent and LOI-free.
- **Wave 2:** U3 (buildable now, dark; enabling awaits the LOI) and U4 (surfaces
  U2's enrichment, extends to U3's when present).

## 3. Unit specs

### U1 — Active-line lyric highlight
- id: `U1`
- depends_on: []
- scope: Pass the current playback position into `LyricsPanel` (add an
  `activePlayer: IPlayer | null` prop from `client.tsx`, poll
  `getCurrentPositionMs()` at ~250-500ms while the panel is open). Compute the
  active synced-line index (`line.timeMs <= pos < nextLine.timeMs`), highlight it
  (accent bg + weight, on-palette), and auto-scroll it into view. Plain-lyrics
  fallback unchanged. Reduced-motion safe (no smooth-scroll under
  reduced-motion). No new flag (behaves within the existing `lyrics` flag).
- acceptance_tests: pure `activeLineIndex(synced, positionMs)` (boundaries: before
  first line → -1/0; between lines; after last; empty synced); highlight renders
  on the active line only; auto-scroll respects reduced-motion. Existing lyrics
  behavior intact when no synced lyrics.
- risk_level: Tier 2 (web, position plumbing)
- rollback_plan: revert; panel returns to static list.

### U2 — ListenBrainz enrichment provider
- id: `U2`
- depends_on: []
- scope: New `internal/listenbrainz` package (httpx client, package-var base URL
  for httptest injection, `ErrNotConfigured` when unset). `ListenBrainzProvider`
  func-type + `Hub.WithListenBrainzProvider` + `track.listenbrainz` dispatch case
  (10s timeout, nil-check, error-return-empty). `cmd/server/main.go` wires it
  behind `FEATURE_LISTENBRAINZ` (default off). Client `fetchListenBrainz` in
  `realtime.ts` + a `listenBrainz` flag in `features.ts` (default off).
- acceptance_tests: provider returns typed enrichment for a known MBID/track
  (httptest-injected response); `ErrNotConfigured` when the base is unset;
  dispatch returns an empty object (not an error) when the provider is nil;
  `go test -race` passes.
- risk_level: Tier 2 (new external provider; mirrors track-depth)
- rollback_plan: flag off; revert drops the package with no consumer.

### U3 — Last.fm enrichment provider
- id: `U3`
- depends_on: []
- scope: `match.FetchLastfmEnrichment` (track.getInfo + track.getTopTags →
  playcount, listeners, tags) SEPARATE from `SimilarTracks`. `LastfmEnrichProvider`
  seam + `track.lastfm` dispatch case. Wire in main behind
  `FEATURE_LASTFM_ENRICH` (default off) AND the existing `LASTFM_API_KEY`. Client
  `fetchLastfmEnrich` + `lastfmEnrich` flag (default off).
- acceptance_tests: enrichment parsed from an httptest-injected Last.fm response;
  `ErrNotConfigured` without the key; dispatch empty when provider nil; `-race`.
- risk_level: Tier 2 (external provider)
- **enable_gate**: enabling in production requires a commercial LOI with Last.fm.
  The code ships dark; the flag stays off until the LOI is in place. This is an
  operator/legal gate, not a code blocker.
- rollback_plan: flag off; revert drops the function.

### U4 — Enrichment panel (web)
- id: `U4`
- depends_on: [U2, U3]
- scope: Surface enrichment (ListenBrainz listens/tags; Last.fm playcount/tags
  when present) in the now-playing detail surface (extend `TrackDepthPanel` or a
  sibling), each behind its flag. Graceful empty states.
- acceptance_tests: renders ListenBrainz data when `listenBrainz` on and data
  present; renders Last.fm data when `lastfmEnrich` on; empty state otherwise;
  tsc/vitest/drift clean.
- risk_level: Tier 2 (UI)
- rollback_plan: revert the panel additions.

## 4. Unit scorecards

| Unit | Tier | Integration risk | Effort | Wave | LOI |
| --- | --- | --- | --- | --- | --- |
| U1 lyric highlight | 2 | Low-Med (position plumbing) | M | 1 | no |
| U2 ListenBrainz provider | 2 | Med (new external API) | M | 1 | no |
| U3 Last.fm enrichment | 2 | Med (external API) | M | 2 | **enable-gated** |
| U4 enrichment panel | 2 | Low (UI) | M | 2 | no |

## 5. Integration risk summary
- **Last.fm LOI** (enable-gate, not code): U3 ships dark; do not enable
  `FEATURE_LASTFM_ENRICH` in production until the commercial LOI is signed.
- **Provider latency**: enrichment RPCs use the 10s timeout + error-return-empty
  pattern, so a slow ListenBrainz/Last.fm never blocks the room.
- **ListenBrainz API shape**: unverified against the live API; U2's acceptance
  tests use httptest injection, and a real-API smoke check is a follow-up.
- **Highlight vs sync**: the highlight reads the LOCAL player position, so it is
  correct solo and free when synced; it does not depend on `FEATURE_SYNC`.

## 6. Merge queue order
`U1 ∥ U2` → `U3 ∥ U4` (U4 after U2). Rebase each on main before merge; re-run
`go test -race ./...` + web tsc/vitest + drift after each queued merge.
