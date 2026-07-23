# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Server-stamped `TrackRef.addedAt` / `RoomState.createdAt` timestamps; queue rows show relative added-times (#132)
- Queue voting (F4): members upvote queued tracks via `queue.vote`, live counts + listeners-pick marker, host keeps order control (#130)

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
