# Multi-stage build for Next.js web app
# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /build

# Install pnpm (pinned to match the root packageManager field, so the frozen
# install below cannot fail on a version mismatch).
RUN npm install -g pnpm@11.11.0

# Copy MANIFESTS ONLY first (build context is the REPO ROOT; see
# .github/workflows/deploy.yml). Source is copied after `pnpm install` so a
# code-only change re-uses the cached dependency layer instead of busting it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json

# Install dependencies (only re-runs when a manifest or the lockfile changes)
RUN pnpm install --frozen-lockfile

# Now copy the workspace member sources (apps/web + packages/*).
# apps/server is a separate Go module and is NOT needed for the web build.
COPY packages ./packages
COPY apps/web ./apps/web

# Build web app (generates standalone output)
RUN pnpm --filter web build

# Stage 2: Runtime (minimal Node image; major-pinned to match CI's node 22)
FROM node:22-alpine

WORKDIR /app
# Bind on all interfaces inside the container; Next standalone reads these.
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

# Next standalone in a pnpm monorepo with outputFileTracingRoot=repo root nests
# the server + traced deps under apps/web/. Copy the whole standalone tree, then
# the static assets into their nested location (standalone omits them). There is
# no public/ dir in this app, so it is not copied. Owned by the non-root `node`
# user that ships with the official image.
COPY --from=builder --chown=node:node /build/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /build/apps/web/.next/static ./apps/web/.next/static

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000 || exit 1

# server.js lives at apps/web/server.js inside the standalone tree.
ENTRYPOINT ["node", "apps/web/server.js"]
