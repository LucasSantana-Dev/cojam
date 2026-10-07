# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Host moderation tools: `chat.delete` and `room.kick` (#227)
- Chat system messages for track changes and member join/leave (#228)
- Activity rail, shared room-age clock and guest identity signal in the room (#229)
- Guest-to-account upgrade with attribution rebind (#233)
- Member reports and a moderation audit trail (#286)
- Age gate on the public-directory path (#281)
- Server-side Spotify token custody with exchange and refresh endpoints; the browser no longer holds Spotify tokens (#278, #279, #280)
- Chat now says when a rollover ended it (#278)
- Public liveness probe at `/api/healthz` (#271) and an external uptime check for production (#284)
- Client telemetry in the existing metrics stack (#276)
- `TrackRef.kind` discriminator for video co-watch (#285)
- CONTEXT.md glossary and design specs for uptime, voice chat, premium tiers, ECA minor safety and Apple Music (#270, #272, #273, #275, #277, #282)
- Server-stamped `TrackRef.addedAt` / `RoomState.createdAt` timestamps; queue rows show relative added-times (#132)
- Queue voting (F4): members upvote queued tracks via `queue.vote`, live counts + listeners-pick marker, host keeps order control (#130)

### Changed

- Room layout gains a tablet breakpoint (#294)
- Violet is now a design token instead of scattered literals (#295)
- Deployment docs describe how CoJam is actually deployed (#267)
- Dependency bumps (npm minor/patch groups, GitHub Actions, jsdom 30) (#164, #235, #236, #240, #304, #305)

### Fixed

- Race-proofed the queue undo window against concurrent activity (#230)
- RPC no longer fails when publish fails after state was committed (#178, #231)
- Room-auth guest votes are pruned on disconnect (#234)
- Supabase sign-in pair is hidden when the auth feature is off (#266)
- Production-readiness wave 1 fixes (#274)
- Closed the hex escapes in the OKLCH colour system (#287, #292)
- Ciphertext tamper test now flips ciphertext bytes, not base64 text (#293)

### Security

- Added security headers and fixed a build-baked localhost canonical URL (#237)
- Stopped trusting `x-forwarded-proto` in production (#239)

## [0.2.0] - 2026-07-21

### Added

- Provider-ranked search, Supabase accounts, Google SSO (#70)
- Client-supplied tracks for playlist.import (RFC-0007) (#74)
- Listeners can remove their own queued tracks (B16) (#106)
- Per-user rate limiting on third-party-fanout RPCs (B15) (#105)
- Auto-advance at track end and live transport readout (B6+B7) (#98)

### Fixed

- Surface playlist.import errors to clients (#71)
- Replace removed `next lint` with ESLint 9 flat config (#72)
- Stop truncating the aggregated search pool before ranking (#73)
- Surface RPC failures inline instead of failing silently (B12) (#101)
- Stop firing doomed server imports for unauthenticated Spotify playlists (#102)
- Refresh connection token, resync on reconnect, bound the join wait (B9-B11) (#100)
- Require proof of ownership to reissue a connection identity (#94)
- Validate queue.add track input like playlist.import (#95)
- Copy radio refill seed instead of pointing into the live queue (#96)
- Single *Room per roomID under concurrent GetOrCreateRoom (#99)
- Bound HTTP header/idle time and store IO (B14) (#103)
- Enrich exactly the imported tracks when the queue is partially full (#104)

### Changed

- Adopt eslint-config-next/typescript preset (#75)
- Fix all react-hooks v6 warnings (#76)

## [0.1.0] - Initial tagged release
