# ADR-0002: Catalog-provider shape — minimal dedup, no provider interface (yet)

**Date:** 2026-07-17
**Status:** accepted
**Decided via:** /research-and-decide (options brainstorm + decision-critic adversarial pass + operator decision)

## Context

Third-party music-catalog access grew organically across this session's search,
playlist-import, and radio features. `internal/match/match.go` is ~932 lines with
9 free functions hitting Spotify, Deezer, Tidal, YouTube, Last.fm, and MusicBrainz;
`internal/playlist/playlist.go` adds 3 more. Two real frictions surfaced in an
architecture review:

- **Duplication.** Every function repeats the same shape: build request →
  `httpx.Client.Do` → status check → `json.NewDecoder(io.LimitReader(...)).Decode`
  → map to a domain type. And `spotifyAccessToken` is duplicated in both packages —
  match's copy is cached (mutex + expiry), playlist's copy has **no cache** and
  re-fetches a client-credentials token on every import (a latent correctness/perf bug).
- **Missing seam?** There is no uniform "catalog provider" abstraction; the hub
  package already exposes four func-type seams (`Matcher`, `Searcher`,
  `PlaylistFetcher`, `SimilarProvider`), each with exactly one production adapter.

The question: what shape should the catalog-provider abstraction take?

## Decision

**Option B — minimal dedup, no interface.** Extract the genuinely-shared code and
stop there:

- New `internal/spotifyauth` module: a single cached client-credentials token,
  consumed by both `match` and `playlist` (kills the duplicate + the uncached
  re-fetch bug).
- New `internal/httpx.DoJSON(req, v)` helper: the request→do→status→LimitReader→decode
  boilerplate in one place (so a future provider cannot forget the response-size cap
  or leak an upstream error body — the exact things the recent security hardening fixed).
- Keep the per-operation **free functions**. Do NOT introduce a provider interface.

The providers are genuinely non-uniform — different capabilities (Deezer=search-only,
Last.fm=similar-only, MusicBrainz=isrc-only, YouTube=search+resolve) and different
return types (`[]SearchCandidate`, `[]queue.TrackRef`, `*queue.SourceRef`,
`*MusicBrainzRecording`). A uniform interface would force empty methods or false
uniformity.

## Alternatives considered

- **A. One fat `Provider` interface (Search+Similar+Resolve) + registry.** Rejected:
  interface pollution — providers implement disjoint subsets and return different
  types; the fat interface masks real per-provider differences (Spotify.Resolve uses a
  bearer token, YouTube.Resolve uses an API key). Over-abstraction on a 2-week greenfield.
- **C. Small per-capability interfaces (`Searcher`/`Resolver`/`SimilarProvider`) formalizing
  the hub seams.** Rejected *for now*: each seam has exactly one adapter today.
  Formalizing named interfaces before a second implementation violates "two adapters =
  a real seam" — you pay ~200 lines of interface + wiring ceremony for a boundary you
  can't yet know is correct. The critic flagged this as the leading trap.
- **D. No change.** Rejected: leaves the uncached duplicate token (re-fetch every import)
  and the copy-paste boilerplate where a future provider drops the LimitReader/error-sanitize.

The `decision-critic` pass (Opus, artifact-only) independently returned **SOUND → B**,
with the same reasoning (kill the load-bearing friction; defer interfaces to rule-of-two).

## Consequences

- Positive: one place for Spotify auth (bug fixed) and one place for the HTTP-JSON
  contract (locality: security invariants can't be forgotten); ~80 lines of shared code
  vs ~200 for interfaces; httptest injection preserved; trivially reversible.
- Negative: no single "add a provider" entry point — a new provider is still N free
  functions. Acceptable while providers stay non-uniform and single-consumer.
- Neutral: the hub's func-type seams stay as-is (they already provide the test seam).

## Revisit when

A **second real adapter for the same capability** appears — e.g. Apple Music implementing
`Search` + `Resolve` alongside Spotify, or a second `SimilarProvider`. At two adapters the
seam is real (rule-of-two) and Option C (small per-capability interfaces) becomes justified;
promote the func-type seam to a named interface then, not before. Also revisit if the shared
boilerplate grows beyond request→decode (retries, circuit-breaker, rate-limit handling),
which would argue for a lightweight provider struct holding shared state.
