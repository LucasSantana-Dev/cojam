# A RoomState mutation did not update clients live (missing Version bump)

## Summary

The `radio.set` RPC toggled `RadioEnabled` server-side and persisted it (correct
after a reload), but the toggle did not flip live in the UI — the click appeared
to do nothing until the page was reloaded.

## Root Cause

The web store's `setState` (`apps/web/lib/realtime.ts`) accepts an incoming room
publication only when `state.version > current.version`. Every queue mutation
bumps `RoomState.Version`, but the `radio.set` mutate closure set `RadioEnabled`
without `s.Version++`, so the published snapshot had the same version and the
client's guard silently discarded it. On reload/join the client accepts the
fresh state, hiding the bug.

## Prevention

- **Rule:** any `RoomState` mutation whose result is published to clients MUST
  bump `RoomState.Version` (do it in the `h.mutate` closure or the `queue`
  method).
- **Detection:** for every mutating RPC, add a test asserting the returned
  `RoomState.Version` increased (see `hub_radio_test.go`). A mutation that
  changes state but not version is the smell.

## Evidence

Found and fixed during the 2026-07-17 audit of the radio feature; fix added
`s.Version++` to the `radio.set` closure in `apps/server/internal/hub/hub.go`.
