import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const server = process.env.SERVER_ORIGIN ?? 'http://localhost:8080';
    return [{ source: '/api/apple/:path*', destination: `${server}/api/apple/:path*` }];
  },
};

export default config;
