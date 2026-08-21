import type { MetadataRoute } from 'next';
import { resolveSiteUrl } from '@/lib/siteUrl';

// /room/* is disallowed on purpose: rooms are ephemeral, and a private room's
// only protection is that its ID is unguessable. Indexing them would publish
// the capability.
export default async function robots(): Promise<MetadataRoute.Robots> {
  const siteUrl = await resolveSiteUrl();
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/room/', '/account', '/callback/'],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
