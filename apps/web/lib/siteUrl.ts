import { headers } from 'next/headers';

// `/` prerenders as a static page, so a plain module-level env-var read gets
// baked in at `next build` time, not re-read at runtime — a NEXT_PUBLIC_ var
// would additionally break the environment-agnostic image (see
// publish-web-image.yml). COJAM_SITE_URL (set at deploy, no NEXT_PUBLIC_
// prefix needed since this is server-only) is the recommended override;
// falling back to the request's own Host header keeps behavior correct even
// if it's unset, at the cost of opting this route into dynamic rendering.
export async function resolveSiteUrl(): Promise<string> {
  const configured = process.env.COJAM_SITE_URL;
  if (configured) return configured;
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host');
  if (!host) return 'http://localhost:3000';
  // Don't trust x-forwarded-proto in production: Cloudflare terminates TLS,
  // but the Caddy->container hop behind it is plain HTTP, so Caddy forwards
  // 'http' even though the public site is always HTTPS. Trusting that header
  // produced a real bug — canonical (resolved via metadataBase, apparently
  // through a different Next.js internal path) came out https while
  // openGraph.url/jsonLd.url (this same value, used directly) came out http.
  // This deployment has no legitimate non-HTTPS production case, so decide
  // by NODE_ENV alone and skip the unreliable header entirely.
  const proto =
    process.env.NODE_ENV === 'production' ? 'https' : (h.get('x-forwarded-proto') ?? 'http');
  return `${proto}://${host}`;
}
