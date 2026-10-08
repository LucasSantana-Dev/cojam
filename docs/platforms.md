# Platform support

CoJam follows the Stationhead / Vertigo model: per-user streams synchronized by metadata. It never rebroadcasts one audio stream to many listeners, the model that violates streaming agreements and killed turntable.fm.

| Platform | Status | SDK | Notes |
| --- | --- | --- | --- |
| YouTube | Supported | IFrame embed | Public API, web only |
| Spotify | Supported | Web Playback SDK | Premium per user; Dev Mode capped at 5 |
| YouTube Music | Unsupported | None | No official API |
| Deezer | Search/identity (default) | None | Keyless public search API; playback SDK closed to new apps since 2024 |
| Tidal | Unsupported | SDK | Full-catalog license agreement required |

Cross-service master offset is roughly 500 ms. That is physics (different masters per service), not a bug.
