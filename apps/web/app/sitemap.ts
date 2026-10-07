import type { MetadataRoute } from 'next';
import { resolveSiteUrl } from '@/lib/siteUrl';

// Landing and the public rooms directory. Individual rooms are ephemeral and
// capability-protected; /account and /callback are per-user.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const siteUrl = await resolveSiteUrl();
  return [
    {
      url: siteUrl,
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${siteUrl}/rooms`,
      changeFrequency: 'hourly',
      priority: 0.6,
    },
  ];
}
