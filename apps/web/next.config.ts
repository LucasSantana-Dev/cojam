import type { NextConfig } from 'next';
import path from 'path';
import { buildCsp } from './lib/csp';

const config: NextConfig = {
  reactStrictMode: true,
  // Spotify requires the loopback IP (127.0.0.1) as the OAuth redirect host, not
  // localhost. Next 16 blocks cross-origin dev resources for non-localhost hosts
  // by default, which breaks hydration when the app is opened at 127.0.0.1:3000.
  allowedDevOrigins: ['127.0.0.1'],
  // Standalone output for Docker deployments
  output: 'standalone',
  images: {
    // Artwork CDN (mzstatic) used by the landing-page demo room cards.
    remotePatterns: [{ protocol: 'https', hostname: 'is1-ssl.mzstatic.com' }],
  },
  // outputFileTracingRoot ensures the standalone build includes workspace dependencies
  // (packages/shared) when built from a monorepo root context
  outputFileTracingRoot: path.resolve(__dirname, '../..'),
  async rewrites() {
    const server = process.env.SERVER_ORIGIN ?? 'http://localhost:8080';
    // Dev/e2e only in practice: in production Caddy routes /api/* to the Go
    // server before Next sees it.
    return [
      { source: '/api/stats/:path*', destination: `${server}/api/stats/:path*` },
    ];
  },
  // Security headers — CoJam shipped none of these. connect-src covers the
  // same-origin websocket (wss upgrades keep the http(s) origin), Spotify's
  // OAuth/API hosts, and any *.supabase.co project (URL is runtime-configured
  // via /env.js, not known at build time). next/font self-hosts fonts at
  // build time, so no external font-src is needed.
  // Production-only: e2e (`pnpm dev`) points NEXT_PUBLIC_WS_URL at the Go
  // server's own port (ws://localhost:8080), a genuinely cross-origin
  // connection only in local dev — production is same-origin via Caddy
  // path-routing, which connect-src 'self' already covers correctly.
  async headers() {
    if (process.env.NODE_ENV !== 'production') return [];
    return [
      // The service worker must always be revalidated, or a deploy could leave
      // clients on an old worker. Listed first; Next merges matching rules, so
      // the security headers below still apply to it.
      {
        source: '/sw.js',
        headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
      },
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            // Built in lib/csp.ts (per-directive origin allowlist, unit tested).
            value: buildCsp(),
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ];
  },
};

export default config;
