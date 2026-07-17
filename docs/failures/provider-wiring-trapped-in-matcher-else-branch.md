# Provider wiring trapped inside the matcher `else` branch

## Summary

In `apps/server/cmd/server/main.go`, the aggregated search, playlist import,
radio auto-refill, track-depth, and lyrics providers were all wired **inside**
the YouTube-matcher `else` branch, and additionally inside an `if
FEATURE_MATCHING` block whose closing brace was misplaced. Because of the
mis-nesting, those five providers only got wired when **no YouTube matcher was
configured** (`YOUTUBE_API_KEY` unset) **and** `FEATURE_MATCHING` was on.

In any deployment with a `YOUTUBE_API_KEY` set (the intended production config),
the matcher `if` branch was taken and the entire `else` was skipped, so
`track.search`, `playlist.import`, `radio.set`, `track.depth`, and
`track.lyrics` were all silently dead. The code compiled and every test passed,
because Go is whitespace-insensitive and no test booted with a YouTube key.

## Root Cause

Two brace mistakes compounded:

1. The `if featureEnabled("FEATURE_MATCHING")` searcher block was never closed
   before the playlist/radio/depth/lyrics blocks, so they nested inside it.
2. That whole run of independent providers lived inside the matcher `else`
   (`YOUTUBE_API_KEY` unset) instead of at the top level.

Independent, separately-flagged providers must not be gated by an unrelated
control-flow branch. Indentation looked plausible only because gofmt had not
normalized the block.

## Prevention

- Providers gated by their own `FEATURE_*` flag are wired at the top level of
  `main`, never inside the matcher selection branch. The matcher `if/else` now
  contains only matcher wiring and its disabled-log, and closes before any
  independent provider.
- Detection: boot-time smoke check. With `YOUTUBE_API_KEY` set plus
  `FEATURE_LYRICS=1 FEATURE_TRACK_DEPTH=1`, the startup log must emit
  `matcher_enabled` **and** `lyrics_enabled` + `track_depth_enabled` +
  `searcher_enabled`. If a provider's `*_enabled` line is missing while its flag
  is on, it is trapped in a branch again.
- Same class as `docs/failures/rpc-provider-wired-but-dispatch-case-missing.md`:
  a provider that is "wired" in code but unreachable at runtime. Verify the
  runtime log, not just the presence of the wiring call.

## Evidence

- Flagged by CodeRabbit on PR #24 (two Major findings: "Move lyrics wiring
  outside the matching branches" and "Wire the cached fetcher, not FetchLyrics
  directly").
- Fix verified: `go test -race ./...` (112 pass) + boot with `YOUTUBE_API_KEY`
  set now logs all five `*_enabled` providers.
