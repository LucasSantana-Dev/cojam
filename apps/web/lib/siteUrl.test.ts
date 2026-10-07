import { afterEach, describe, expect, it, vi } from 'vitest';

const headerGet = vi.fn();
vi.mock('next/headers', () => ({ headers: async () => ({ get: headerGet }) }));

import { PRODUCTION_FALLBACK_SITE_URL, resolveSiteUrl } from './siteUrl';

afterEach(() => {
  vi.unstubAllEnvs();
  headerGet.mockReset();
});

describe('resolveSiteUrl', () => {
  it('prefers COJAM_SITE_URL', async () => {
    vi.stubEnv('COJAM_SITE_URL', 'https://configured.test');
    vi.stubEnv('NODE_ENV', 'production');
    expect(await resolveSiteUrl()).toBe('https://configured.test');
  });

  it('in production without COJAM_SITE_URL ignores request headers', async () => {
    vi.stubEnv('COJAM_SITE_URL', '');
    vi.stubEnv('NODE_ENV', 'production');
    headerGet.mockReturnValue('attacker.test');
    expect(await resolveSiteUrl()).toBe(PRODUCTION_FALLBACK_SITE_URL);
    expect(headerGet).not.toHaveBeenCalled();
  });

  it('in development falls back to the Host header', async () => {
    vi.stubEnv('COJAM_SITE_URL', '');
    vi.stubEnv('NODE_ENV', 'development');
    headerGet.mockImplementation((k: string) => (k === 'host' ? 'localhost:3000' : null));
    expect(await resolveSiteUrl()).toBe('http://localhost:3000');
  });
});
