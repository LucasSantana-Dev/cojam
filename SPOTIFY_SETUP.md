# Spotify dev-mode setup (operator steps)

Spotify Web Playback SDK needs: a **free** Spotify Developer app (Client ID, public),
a registered redirect URI, and each *playing* listener on **Spotify Premium**
(free accounts can join rooms but Premium is required to stream via the SDK).
Dev mode caps the app at **5 users** you allowlist by email.

## 1. Create the app (developer.spotify.com — free, needs a Spotify login)

1. https://developer.spotify.com/dashboard → **Create app**.
2. Name/description: anything (e.g. `music-jam`).
3. **Redirect URI**: `http://localhost:3000/callback/spotify` (add your deployed
   origin + `/callback/spotify` later).
4. APIs to use: check **Web Playback SDK**.
5. Accept the Spotify Developer Terms (operator action) → Save.
6. Copy the **Client ID** (it is public, not a secret; there is no client secret
   in the PKCE flow).

## 2. Allowlist test users (dev mode, 5 max)

Dashboard → your app → **User Management** → add the name + Spotify-account email
of each person who will play (yourself included). They must be Premium to stream.

## 3. Configure the web app

Create `apps/web/.env.local` (gitignored):

```sh
NEXT_PUBLIC_FEATURE_SPOTIFY=on
NEXT_PUBLIC_SPOTIFY_CLIENT_ID=<client id from step 1>
```

Feature toggles (all optional; `1/true/on/yes` vs `0/false/off/no`):

| var | default | gates |
|---|---|---|
| `NEXT_PUBLIC_FEATURE_YOUTUBE` | on | YouTube player + its add field |
| `NEXT_PUBLIC_FEATURE_SPOTIFY` | off | Spotify connect/player + add field |
| `NEXT_PUBLIC_FEATURE_APPLE` | off | Apple connect/player + add field |
| `FEATURE_MATCHING` (server) | on | async YouTube match enrichment (also needs `YOUTUBE_API_KEY`) |

## 4. Run + test

```sh
pnpm --filter web dev          # :3000
cd apps/server && go run ./cmd/server   # :8080
```

In a room: **Connect Spotify** → authorize (Premium account) → add a track with a
**Spotify Track URI** (`spotify:track:...`, from the desktop app: Share → Copy
Spotify URI) → for authorized-Spotify listeners it plays via the Web Playback SDK;
everyone else falls back to YouTube. Source priority per client: spotify > apple > youtube.

## Notes

- The Client ID is compiled into the client bundle (public by design for PKCE) — fine.
- Tokens live in `sessionStorage`, refreshed 60s before expiry.
- Extended access (past 5 users) is a later application to Spotify with the live app.

## 5. Server-side Spotify track matching (optional)

The server can automatically resolve Spotify track URIs for queued tracks by title/artist
or ISRC, mirroring the YouTube matching feature. This requires **different** credentials
from the web app (server uses client-credentials flow, not PKCE).

### Create a second Spotify app for server (optional step)

Spotify restricts the same app to one OAuth flow. If you want server-side matching:

1. https://developer.spotify.com/dashboard → **Create app** (different from step 1).
2. Name: e.g. `music-jam-server`.
3. Accept terms (no redirect URI needed for client-credentials).
4. In **Settings** → **Show Client Secret** (this is a secret; keep it safe).
5. Copy both **Client ID** and **Client Secret**.

### Configure server

Create `.env` (or export to shell, gitignored):

```sh
FEATURE_MATCHING=on
SPOTIFY_CLIENT_ID=<client id from new app>
SPOTIFY_CLIENT_SECRET=<client secret from new app>
```

When both are set and `FEATURE_MATCHING=on`, the server will:
- Attempt ISRC search first if a track has an ISRC code.
- Fall back to title+artist search.
- Return `(nil, nil)` if no match above MinConfidence (0.4).
- Cache results in-memory to avoid re-hitting Spotify API.

### Verify in logs

```sh
cd apps/server && go run ./cmd/server
```

Check logs for:
- `"spotify_matcher_enabled"` if credentials are set and FEATURE_MATCHING is on.
- `"spotify_match_applied"` when a track is successfully resolved.
- `"spotify_match_miss"` when no confident match was found.

All Spotify matcher cache hits/misses are logged as `"spotify_match_cache"`.

