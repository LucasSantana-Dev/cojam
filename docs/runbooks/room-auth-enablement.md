# Runbook: enabling room roles + authorization

Room roles ship **dark** by default. The signed-identity foundation, host tracking, server
enforcement, and UI gating all exist (RFC-0005); this runbook is the operator checklist to turn it
on. Nothing changes until you set the flags and a secret.

## What "on" gives you

- Every connection is authenticated with a server-signed anonymous token (a stable id, no accounts
  or passwords). Identity is unforgeable without the server secret.
- Each room has a **host**: the first authenticated joiner. If the host leaves, the next
  authenticated joiner reclaims the room.
- **Host-only controls** (skip, set now-playing, reorder, remove, radio, playlist import, and all
  transport play/pause/seek) are enforced server-side: a non-host is rejected with
  `ErrorPermissionDenied`. Any member can still add tracks (`queue.add`).
- The web UI hides/disables host-only controls for listeners (convenience; the server is the real
  gate).

## Threat model

Trusted friend group joining by room code. Defends against accidental stomping and casual griefing
inside a room. It is not accounts, not cross-device identity, and not defense against someone who
holds the server secret.

## Configuration

### Server (`apps/server`)

| Variable | Purpose |
|---|---|
| `FEATURE_ROOM_AUTH=true` | Enables signed identity + host enforcement. |
| `ROOM_AUTH_SECRET` | HMAC secret (HS256) for signing/validating connection tokens. **Required when the flag is on** - if empty, all connections are rejected (fail-closed). Use a long random value; keep it stable (rotating it invalidates live tokens). |

### Web (`apps/web`)

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_FEATURE_ROOM_AUTH=true` | Web fetches a connection token and sends it; UI role gating activates. |

## Enable checklist

1. Generate a strong `ROOM_AUTH_SECRET` (e.g. 32+ random bytes) in the server environment.
2. Server: set `FEATURE_ROOM_AUTH=true` + `ROOM_AUTH_SECRET`; restart. A connection with no/invalid
   token is now rejected; valid tokens set a trusted user id.
3. Web: set `NEXT_PUBLIC_FEATURE_ROOM_AUTH=true`.
4. Open a room: the first person to join becomes host and sees full controls; a second person
   sees host-only controls disabled ("Only the host can ...").
5. Confirm a non-host's skip/reorder/remove/transport attempts are rejected server-side (not just
   hidden) - the server is authoritative.

## Rollback

Unset `FEATURE_ROOM_AUTH` (server) and `NEXT_PUBLIC_FEATURE_ROOM_AUTH` (web); restart. Connections
accept empty tokens again, no host is recorded, and every member has equal rights (v0). Safe and
immediate.

## Notes / follow-ups

- Persisted rooms (RFC-0001) carry `hostUserId` in their snapshot; old snapshots without it
  deserialize fine (host is empty until a fresh authenticated join).
- `queue.remove` is host-only in v1. Allowing listeners to remove their own tracks needs
  `TrackRef.addedBy` to carry the stable `userId` (today it is a display name) - a small follow-up.
- No DJ / co-host tier in v1 (binary host/listener). Kick/ban, room passwords, and private rooms
  are out of scope for this RFC.
