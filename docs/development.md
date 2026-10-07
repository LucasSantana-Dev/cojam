# Development

## Testing

```bash
pnpm test:server                       # Go: go test -race ./...
pnpm --filter web exec vitest run      # web unit
pnpm --filter web e2e                  # web e2e (two-browser room sync)
```

> [!NOTE]
> The migration, store, and room-reload tests need a real Postgres and skip silently without one. Set `TEST_DATABASE_URL` to run them:
>
> ```bash
> TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/cojam_test?sslmode=disable \
>   pnpm test:server
> ```
>
> CI provides this via a Postgres service container, so these run on every PR.

<!-- Separate GitHub alert blocks; a bare blank line trips MD028. -->

> [!WARNING]
> Always use `pnpm --filter web e2e`, never raw `playwright test`. The e2e script frees port 3000 first; a stale dev server on :3000 makes Playwright's web server hang and report "0 tests". Details in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Project layout

```text
cojam/
├── apps/
│   ├── web/              # Next.js 16 frontend (app/, lib/, e2e/)
│   └── server/           # Go server (cmd/server, internal/hub|match|queue|obs)
├── packages/shared/      # TS protocol types: TrackRef, RoomState
├── docs/                 # protocol + specs; ADRs and runbooks
│                         # (launch-readiness, feature-rollout-plan, feature-flags,
│                         # backup-restore) are local-only, gitignored
└── pnpm-workspace.yaml
```

Architecture decisions live in `docs/adr/` (local-only).

## Architecture notes

One centrifuge channel serves each room (`room:<id>`). Clients subscribe to a room to be authorized to mutate it; the server is authoritative for queue state. RPC commands (`queue.add`, `queue.reorder`, `now_playing.advance`) each publish the full `RoomState` on mutation. Wire protocol: [`protocol.md`](protocol.md).

## Health checks

`GET /api/healthz` is the public liveness probe. It returns `{"status":"ok"}` and is the only health endpoint reachable through the public hostname, so it is what an external uptime check should target. `/healthz` and `/readyz` are on the server port and are not publicly routed.

## Deploying

The published images are environment-agnostic: one build runs anywhere, and every deployment-specific value is supplied at runtime. There is no build-time configuration to change and no deploy workflow in this repo, by design. Images are published to GHCR when app sources change on main (`ghcr.io/lucassantana-dev/cojam-web`, `ghcr.io/lucassantana-dev/cojam-server`).

CoJam runs self-hosted: a container host behind a reverse proxy that terminates TLS and path-routes a single hostname.

- `/connection/*` and `/api/*` reach the **Go server**.
- everything else reaches the **Next.js app**, which serves `/env.js`.

The web app defines no `/api/*` routes, so the split is collision-free.

Two constraints are easy to get wrong:

1. **Publish the container ports where the proxy can reach them.** If the proxy dials `127.0.0.1` and the containers publish on another interface, every request becomes a 502 while both containers still report healthy, because their healthchecks probe from inside the container. This has happened.
2. **`/healthz` is not reachable through the public hostname.** It belongs to the Go server, and the proxy only routes `/connection/*` and `/api/*` there, so a public `/healthz` hits the Next.js app and 404s. Probe `/readyz` on the server port directly, or use `/api/connection-token` from outside.

Rollback is pinning the previous `sha-` image tag and recreating. Room state is in Postgres and survives restarts.

The operator runbooks with host-specific detail (`launch-readiness.md`, `feature-rollout-plan.md`, `backup-restore.md`, `observability.md`) are local-only by repo convention and are not in this repository.
