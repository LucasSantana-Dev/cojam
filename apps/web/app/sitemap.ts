import type { MetadataRoute } from 'next';
import { resolveSiteUrl } from '@/lib/siteUrl';

// Landing, the public rooms directory and the legal pages. Individual rooms are
// ephemeral and capability-protected; /account and /callback are per-user.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const siteUrl = await resolveSiteUrl();
  return [
    {
      url: siteUrl,
      changeFrequency: 'weekly',
      priority: 1,
    },
    { url: `${siteUrl}/privacidade`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${siteUrl}/termos`, changeFrequency: 'yearly', priority: 0.3 },
    {
      url: `${siteUrl}/rooms`,
      changeFrequency: 'hourly',
      priority: 0.6,
    },
  ];
}
