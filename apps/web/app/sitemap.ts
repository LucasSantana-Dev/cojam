import type { MetadataRoute } from 'next';
import { resolveSiteUrl } from '@/lib/siteUrl';

// Landing only. Rooms are ephemeral and capability-protected; /account and
// /callback are per-user. There is nothing else worth indexing.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const siteUrl = await resolveSiteUrl();
  return [
    {
      url: siteUrl,
      changeFrequency: 'weekly',
      priority: 1,
    },
  ];
}
