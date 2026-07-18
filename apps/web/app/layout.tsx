import type { Metadata } from 'next';
import Script from 'next/script';
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

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
const description =
  'Friends on different streaming services listen together in one room. Everyone plays on their own account; CoJam keeps the queue in sync on metadata alone.';

export const metadata: Metadata = {
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

// Minimal WebSite structured data for the public landing. No og:image yet;
// omitted deliberately rather than pointing at a missing asset.
const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'CoJam',
  url: siteUrl,
  description,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
