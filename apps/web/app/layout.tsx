import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { headers } from 'next/headers';
import { Bricolage_Grotesque, Instrument_Sans } from 'next/font/google';
import './globals.css';

// Display face: characterful humanist-grotesque with a display optical cut —
// carries the hero title + oversized backdrop word. Body: clean humanist sans,
// not Inter. Both variable, exposed as CSS vars consumed in globals.css.
const display = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});
const body = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
});

const description =
  'Friends on different streaming services listen together in one room. Everyone plays on their own account; CoJam keeps the queue in sync on metadata alone.';

// `/` prerenders as a static page, so a plain module-level env-var read gets
// baked in at `next build` time, not re-read at runtime — a NEXT_PUBLIC_ var
// would additionally break the environment-agnostic image (see
// publish-web-image.yml). COJAM_SITE_URL (set at deploy, no NEXT_PUBLIC_
// prefix needed since this is server-only) is the recommended override;
// falling back to the request's own Host header keeps behavior correct even
// if it's unset, at the cost of opting this route into dynamic rendering.
async function resolveSiteUrl(): Promise<string> {
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
  const proto = process.env.NODE_ENV === 'production' ? 'https' : (h.get('x-forwarded-proto') ?? 'http');
  return `${proto}://${host}`;
}

export async function generateMetadata(): Promise<Metadata> {
  const siteUrl = await resolveSiteUrl();
  return {
    metadataBase: new URL(siteUrl),
    title: { default: 'CoJam · listen together, across services', template: '%s · CoJam' },
    description,
    applicationName: 'CoJam',
    alternates: { canonical: '/' },
    openGraph: {
      type: 'website',
      siteName: 'CoJam',
      title: 'CoJam · listen together, across services',
      description,
      url: siteUrl,
    },
    twitter: { card: 'summary', title: 'CoJam', description },
  };
}

// Without this Next emits no viewport meta and mobile lays out at ~980px, so
// no responsive CSS applies. Pinch-zoom stays enabled (WCAG 1.4.4).
// themeColor is --color-surface-0 as sRGB hex; theme-color parsing is not
// reliably oklch-aware.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#020202',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const siteUrl = await resolveSiteUrl();
  // Minimal WebSite structured data for the public landing. No og:image yet;
  // omitted deliberately rather than pointing at a missing asset.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'CoJam',
    url: siteUrl,
    description,
  };
  return (
    <html lang="en" className={`dark ${display.variable} ${body.variable}`}>
      <head>
        {/* Runtime client config (WS URL, Spotify client id). Loaded before the
            app so window.__COJAM_ENV__ is set when realtime/auth code runs. */}
        <Script src="/env.js" strategy="beforeInteractive" />
      </head>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only">
          Skip to content
        </a>
        {children}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </body>
    </html>
  );
}
