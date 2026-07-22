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
};

export default config;
