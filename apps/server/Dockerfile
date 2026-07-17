# Multi-stage build for Go server
# Stage 1: Build
FROM golang:1.26-alpine AS builder

WORKDIR /build

# Copy go mod files first so the dependency layer caches independently of source.
COPY go.mod go.sum ./

# Download dependencies (module proxy; no git needed for public modules)
RUN go mod download

# Copy source code
COPY . .

# Build static binary: no CGO, reproducible paths stripped, symbols stripped.
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath -ldflags="-s -w" \
    -o server ./cmd/server

# Stage 2: Runtime (minimal, pinned; never `latest`)
FROM alpine:3.23

WORKDIR /app

# Runtime deps (ca-certificates for outbound HTTPS) + non-root user.
RUN apk add --no-cache ca-certificates \
    && adduser -D -H -u 10001 app

# Copy binary from builder
COPY --from=builder --chown=app:app /build/server .

USER app

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/healthz || exit 1

# Run server
ENTRYPOINT ["./server"]
