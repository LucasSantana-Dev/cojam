import type { NextConfig } from 'next';
import path from 'path';

const config: NextConfig = {
  reactStrictMode: true,
  // Spotify requires the loopback IP (127.0.0.1) as the OAuth redirect host, not
  // localhost. Next 16 blocks cross-origin dev resources for non-localhost hosts
  // by default, which breaks hydration when the app is opened at 127.0.0.1:3000.
  allowedDevOrigins: ['127.0.0.1'],
  // Standalone output for Docker deployments
  output: 'standalone',
  images: {
    // Apple Music artwork CDN used by the landing-page demo room cards.
    remotePatterns: [{ protocol: 'https', hostname: 'is1-ssl.mzstatic.com' }],
  },
  // outputFileTracingRoot ensures the standalone build includes workspace dependencies
  // (packages/shared) when built from a monorepo root context
  outputFileTracingRoot: path.resolve(__dirname, '../..'),
  async rewrites() {
    const server = process.env.SERVER_ORIGIN ?? 'http://localhost:8080';
    return [{ source: '/api/apple/:path*', destination: `${server}/api/apple/:path*` }];
  },
  // Security headers — CoJam shipped none of these. connect-src covers the
  // same-origin websocket (wss upgrades keep the http(s) origin), Spotify's
  // OAuth/API hosts, and any *.supabase.co project (URL is runtime-configured
  // via /env.js, not known at build time). next/font self-hosts fonts at
  // build time, so no external font-src is needed.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https://is1-ssl.mzstatic.com",
              "connect-src 'self' https://accounts.spotify.com https://api.spotify.com https://*.supabase.co",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'",
            ].join('; '),
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
