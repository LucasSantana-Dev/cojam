import type { Metadata } from 'next';
import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
const description =
  'Friends on different streaming services listen together in one room. Everyone plays on their own account; Cojam keeps the queue in sync on metadata alone.';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'Cojam — listen together, across services', template: '%s · Cojam' },
  description,
  applicationName: 'Cojam',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'Cojam',
    title: 'Cojam — listen together, across services',
    description,
    url: siteUrl,
  },
  twitter: { card: 'summary', title: 'Cojam', description },
};

// Minimal WebSite structured data for the public landing. No og:image yet —
// omitted deliberately rather than pointing at a missing asset.
const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'Cojam',
  url: siteUrl,
  description,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
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
