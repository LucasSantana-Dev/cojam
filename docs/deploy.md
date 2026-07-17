# Deployment Runbook

CoJam deploys to Fly.io with Docker containers for both the Next.js web app and the Go server. This runbook covers first-time setup and ongoing deployments.

## Prerequisites

- Fly.io account (free tier sufficient for MVP)
- `flyctl` CLI installed: https://fly.io/docs/hands-on/install-flyctl/
- GitHub repository with admin access (to add secrets)

## Initial Setup (One-time)

### 1. Install flyctl

```bash
# macOS
brew install flyctl

# Linux
curl -L https://fly.io/install.sh | sh

# Verify
flyctl version
```

### 2. Authenticate with Fly.io

```bash
flyctl auth login
```

### 3. Create Fly.io Apps

Create two separate apps: `cojam-server` and `cojam-web`.

```bash
# Create server app
flyctl apps create cojam-server

# Create web app
flyctl apps create cojam-web
```

Fly will ask to select a region; choose the one closest to your users (default `gig` is fine for MVP).

### 4. Set Up Database (Room Persistence)

The server persists room state (queue, now-playing, radio flag) to Postgres when
`DATABASE_URL` is set. Without it, the server runs with in-memory rooms that are
lost on restart, which is fine for local dev but not production. Any Postgres
works; the server does not care where it lives.

Provider options:

- **Fly Managed Postgres** (`fly mpg create --region gru --plan basic` then
  `fly mpg attach <clusterID> -a cojam-server`, which sets `DATABASE_URL`).
  Requires a payment method on the org, and `gig` is not an MPG region (use
  `gru`). The legacy `flyctl postgres create` is deprecated.
- **A free external provider** (e.g. Neon or Supabase — no card, generous free
  tier). Create a database, copy its connection string, and set it as a secret:
  `flyctl secrets set DATABASE_URL="postgres://..." --app cojam-server`.

Optional: set `DIRECT_DATABASE_URL` to the provider's direct (non-pooled)
connection string. The server runs migrations through it when present, since
some poolers restrict DDL; runtime queries always use `DATABASE_URL`. The pool
is configured for pooled/PgBouncer endpoints (unnamed prepared statements), so a
pooled `DATABASE_URL` works without extra flags.

Notes:

- **Migrations run automatically on boot.** The server applies pending migrations
  (currently `0001_rooms.sql`) at startup before serving; no separate release
  command is needed. A migration failure is fatal, so the deploy fails loudly
  rather than serving on a bad schema.
- **Fail-fast:** if `DATABASE_URL` is set but the database is unreachable, the
  server exits instead of silently falling back to in-memory (which would be
  surprise data loss). If you intend to run without persistence, leave
  `DATABASE_URL` unset.
- **Readiness:** point the Fly health check at `GET /readyz`. It returns `200`
  when the process is up and (in Postgres mode) the database answers a ping, and
  `503` if the database is configured but unreachable. `GET /healthz` remains a
  plain liveness check.

### 5. Add GitHub Actions Secret

GitHub Actions needs the Fly API token to deploy. Generate one and add it to your repo.

```bash
# Generate a new Fly API token (visit https://web.fly.io/user/personal_access_tokens or use CLI)
flyctl tokens create deploy

# Copy the token, then in GitHub:
# 1. Go to repo Settings → Secrets and variables → Actions
# 2. Click "New repository secret"
# 3. Name: FLY_API_TOKEN
# 4. Value: (paste the token from flyctl)
# 5. Click "Add secret"
```

## Configuration: Server Secrets

Set environment variables for the server:

```bash
# YouTube API key (for track matching via YouTube)
flyctl secrets set YOUTUBE_API_KEY="<your-key>" --app cojam-server

# Spotify OAuth (client ID and secret for Spotify matcher)
flyctl secrets set SPOTIFY_CLIENT_ID="<id>" SPOTIFY_CLIENT_SECRET="<secret>" --app cojam-server

# CORS origins (comma-separated list of allowed web origins)
# Example for production: https://cojam.fly.dev
# Example for staging: https://staging-cojam.fly.dev,http://localhost:3000
flyctl secrets set CORS_ORIGINS="http://localhost:3000" --app cojam-server

# Feature flags (optional, defaults to true for critical features)
flyctl secrets set FEATURE_MATCHING=true FEATURE_YOUTUBE=true FEATURE_SPOTIFY=true FEATURE_APPLE=true FEATURE_PLAYLIST_IMPORT=true FEATURE_RADIO=true --app cojam-server

# Last.fm (optional; powers the radio auto-refill similar-tracks provider)
flyctl secrets set LASTFM_API_KEY="<key>" --app cojam-server
```

View current secrets:

```bash
flyctl secrets list --app cojam-server
```

## Configuration: Web App Secrets

Set environment variables for the web:

```bash
# Spotify Web Playback SDK client ID
flyctl secrets set NEXT_PUBLIC_SPOTIFY_CLIENT_ID="<id>" --app cojam-web

# Server WebSocket URL (must match where the server is deployed)
# Example: wss://cojam-server.fly.dev/connection/websocket (for production)
# For development: ws://localhost:8080/connection/websocket
flyctl secrets set NEXT_PUBLIC_WS_URL="ws://localhost:8080/connection/websocket" --app cojam-web

# Feature flags (client-side, visible in bundle; safe to disable features)
flyctl secrets set NEXT_PUBLIC_FEATURE_YOUTUBE=true NEXT_PUBLIC_FEATURE_SPOTIFY=true NEXT_PUBLIC_FEATURE_APPLE=true NEXT_PUBLIC_FEATURE_PRESENCE=true --app cojam-web
```

## Deployment

Once setup is complete, deployments happen automatically via GitHub Actions.

### Automatic Deployments

The `.github/workflows/deploy.yml` workflow deploys on:

1. **Release published**: When a GitHub release is created/published
   ```bash
   # Create a release on GitHub (web or CLI)
   # This automatically triggers deploy-server and deploy-web jobs
   ```

2. **Manual trigger**: Via GitHub Actions UI
   ```
   Go to Actions → Deploy → "Run workflow" → Branch: main → Run
   ```

### Manual Deployment (Fallback)

If needed, deploy directly from the CLI:

```bash
# Deploy server
cd apps/server
flyctl deploy --remote-only --app cojam-server

# Deploy web
cd apps/web
flyctl deploy --remote-only --app cojam-web
```

## Monitoring

Check deployment status and logs:

```bash
# List all deployments for server
flyctl status --app cojam-server
flyctl releases --app cojam-server

# View logs
flyctl logs --app cojam-server
flyctl logs --app cojam-web

# SSH into running VM (debugging)
flyctl ssh console --app cojam-server
```

## Environment Variables Reference

### Server (Go)

| Variable | Required | Example |
|----------|----------|---------|
| `DATABASE_URL` | No | `postgres://user:pass@host:5432/db` (room persistence; in-memory if unset. Pooled URLs work as-is) |
| `DIRECT_DATABASE_URL` | No | `postgres://user:pass@direct-host:5432/db` (direct URL used only for migrations; falls back to `DATABASE_URL`) |
| `YOUTUBE_API_KEY` | No | `AIzaSy...` (for YouTube track matching) |
| `SPOTIFY_CLIENT_ID` | No | `abc123...` (for Spotify track matching) |
| `SPOTIFY_CLIENT_SECRET` | No | `secret...` (for Spotify OAuth token) |
| `CORS_ORIGINS` | No | `http://localhost:3000,https://cojam.fly.dev` (default: localhost:3000 + 127.0.0.1:3000) |
| `FEATURE_MATCHING` | No | `true/false` (default: true) |
| `FEATURE_PLAYLIST_IMPORT` | No | `true/false` (default: true; playlist URL import) |
| `FEATURE_RADIO` | No | `true/false` (default: true; auto-refill via Last.fm) |
| `LASTFM_API_KEY` | No | `abc123...` (radio similar-tracks provider; radio stays off without it) |
| `FEATURE_TRACK_DEPTH` | No | `true/false` (default: true; MusicBrainz track.depth RPC) |
| `FEATURE_LYRICS` | No | `true/false` (default: true; LRCLIB lyrics RPC) |

### Web (Next.js)

| Variable | Required | Example |
|----------|----------|---------|
| `NEXT_PUBLIC_SPOTIFY_CLIENT_ID` | No | `abc123...` (for Spotify Web Playback SDK) |
| `NEXT_PUBLIC_WS_URL` | No | `ws://localhost:8080/connection/websocket` (default: http://localhost:8080) |
| `NEXT_PUBLIC_FEATURE_YOUTUBE` | No | `true/false` (default: true) |
| `NEXT_PUBLIC_FEATURE_SPOTIFY` | No | `true/false` (default: true) |
| `NEXT_PUBLIC_FEATURE_APPLE` | No | `true/false` (default: true) |
| `NEXT_PUBLIC_FEATURE_PRESENCE` | No | `true/false` (default: true) |
| `NEXT_PUBLIC_FEATURE_TRACK_DEPTH` | No | `true/false` (default: true; Track Depth panel) |
| `NEXT_PUBLIC_FEATURE_LYRICS` | No | `true/false` (default: true; Lyrics panel) |

## Rollback

If a deployment breaks production, rollback the latest release:

```bash
flyctl releases --app cojam-server
flyctl releases rollback --app cojam-server

# Or specify a release ID
flyctl releases rollback <id> --app cojam-server
```

## Troubleshooting

### Deployment hangs or times out

- Check Fly.io status: https://status.fly.io
- Verify GitHub Actions secret is set and valid
- Run `flyctl status --app cojam-server` to check VM state

### Health check failures

- Server: `/healthz` endpoint must return 200 OK
- Web: `/` must respond (Next.js server.js running)
- Check logs: `flyctl logs --app cojam-server`

### WebSocket connection failures

- Verify `CORS_ORIGINS` on server includes web app origin
- Verify `NEXT_PUBLIC_WS_URL` on web matches server deployment URL
- Ensure `NEXT_PUBLIC_WS_URL` uses `wss://` (secure) for HTTPS deployments

## Cost Management

Fly.io's free tier includes:

- 3 shared-cpu-1x VMs (used for server + web + eventual DB)
- 160GB of egress per month
- Auto-stop/start keeps costs minimal when idle

For production load >100 concurrent rooms, consider upgrading to dedicated VMs.
