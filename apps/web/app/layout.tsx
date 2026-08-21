import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { Bricolage_Grotesque, Instrument_Sans } from 'next/font/google';
import './globals.css';
import { resolveSiteUrl } from '@/lib/siteUrl';
import { WebVitals } from '@/app/components/WebVitals';

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
    // large_image, not summary: opengraph-image.tsx is 1200x630, and the
    // file-convention image is picked up for twitter automatically.
    twitter: { card: 'summary_large_image', title: 'CoJam', description },
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
  // Minimal WebSite structured data for the public landing.
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
        <WebVitals />
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
