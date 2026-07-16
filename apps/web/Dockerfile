# Multi-stage build for Next.js web app
# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /build

# Install pnpm
RUN npm install -g pnpm

# Copy root package files + workspace manifest (build context is the REPO ROOT;
# see .github/workflows/deploy.yml which builds web with --dockerfile from root).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy the workspace members pnpm-workspace.yaml declares (apps/web + packages/*).
# apps/server is a separate Go module and is NOT needed for the web build.
COPY packages ./packages
COPY apps/web ./apps/web

# Install dependencies
RUN pnpm install --frozen-lockfile

# Build web app (generates standalone output)
RUN pnpm --filter web build

# Stage 2: Runtime (minimal Node image)
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Next standalone in a pnpm monorepo with outputFileTracingRoot=repo root nests
# the server + traced deps under apps/web/. Copy the whole standalone tree, then
# the static assets into their nested location (standalone omits them). There is
# no public/ dir in this app, so it is not copied.
COPY --from=builder /build/apps/web/.next/standalone ./
COPY --from=builder /build/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000 || exit 1

# server.js lives at apps/web/server.js inside the standalone tree.
ENTRYPOINT ["node", "apps/web/server.js"]
