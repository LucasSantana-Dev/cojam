# Feature removal left stale references in comments and log fields

## Summary

The Tidal-integration removal deleted the provider code and tests but missed a
comment ("Deezer + Spotify + Tidal") and a structured-log field
(`aggregated(deezer+spotify+tidal)`) in `apps/server/cmd/server/main.go`. Build,
vet, and tests stayed green because prose in comments and string literals never
breaks compilation. Stale strings like these mislead future readers and pollute
log-based dashboards.

## Root Cause

Removal work is naturally driven by the type system: delete the symbols, chase
compile errors, done. Free-text references (comments, log messages, doc strings,
badge labels) have no compiler and survive unless something greps for them.

## Prevention

Manual review point (automation would be misleading here since historical ADRs
legitimately keep old names): before declaring a removal done, run
`grep -rniE "<term>"` across the repo, including docs, and justify every
remaining hit (ADRs recording history are the expected survivors). AGENTS.md
records this as a removal-checklist step.

## Evidence

2026-07-17 `chore/drop-tidal`: the orchestrator's post-removal grep found 2
missed references in main.go after the builder agent reported the removal
complete; fixed in the same commit (0bf040c).
