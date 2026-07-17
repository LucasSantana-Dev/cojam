# RPC provider wired but dispatch case missing

## Summary

The `track.lyrics` feature had its provider seam (`LyricsProvider`,
`WithLyricsProvider`) and `main.go` wiring in place, and the provider's own unit
tests passed, but the `case "track.lyrics"` was never added to the `hub.dispatch`
switch. The live RPC returned `104: method not found` and the UI showed "Failed
to fetch lyrics", while every Go test stayed green.

## Root Cause

The provider tests exercise `FetchLyrics` directly with an httptest stub; they
never route through `hub.dispatch`. A method is only reachable if its `case` is
in the switch, and nothing tested the switch for the new method. So the whole
"is this RPC actually registered?" question had no coverage.

Second-order issue found the same session: `FetchLyrics` early-returned on the
`/api/get` 404 (LRCLIB 404s on a duration mismatch) *before* the `/api/search`
fallback, so real queue tracks always returned empty. And a new `/api/search`
call in the provider hit the real network in `TestFetchLyrics_EmptyResult`
because the stub only overrode `lrclibURL`, not `lrclibSearchURL`.

## Prevention

- Every new RPC method gets a **dispatch-level** test through `hub.HandleRPC`
  (not just a provider test): `TestHandleRPC_TrackLyricsDispatch` asserts the
  method resolves (no "method not found") both with and without a provider.
- Any test stub must override **all** package URL vars a code path can reach
  (`lrclibStub` now wires `/api/get` AND `/api/search` to the httptest server and
  serves `[]` for search by default, so no test can hit the real network).
- Manual review point for new RPCs: grep the dispatch switch for the method
  string before declaring the feature done.

## Evidence

2026-07-17 `feat/lyrics`: caught by browser-verifying the live flow (server log
`err":"104: method not found"`), not by CI. Fixed by adding the `case`, the
get->search fallthrough, and the two regression tests above.
