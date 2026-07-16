import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Spotify requires the loopback IP (127.0.0.1) as the OAuth redirect host, not
  // localhost. Next 16 blocks cross-origin dev resources for non-localhost hosts
  // by default, which breaks hydration when the app is opened at 127.0.0.1:3000.
  allowedDevOrigins: ['127.0.0.1'],
  async rewrites() {
    const server = process.env.SERVER_ORIGIN ?? 'http://localhost:8080';
    return [{ source: '/api/apple/:path*', destination: `${server}/api/apple/:path*` }];
  },
};

export default config;
