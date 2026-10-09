import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { Bricolage_Grotesque, Instrument_Sans } from 'next/font/google';
import './globals.css';
import { resolveSiteUrl } from '@/lib/siteUrl';
import { jsonLdScript } from '@/lib/jsonLd';
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
  'Amigos em serviços de streaming diferentes ouvem juntos numa só sala. Cada um toca na própria conta; o CoJam mantém a fila em sincronia só com metadados.';

export async function generateMetadata(): Promise<Metadata> {
  const siteUrl = await resolveSiteUrl();
  return {
    metadataBase: new URL(siteUrl),
    title: { default: 'CoJam · ouçam juntos, entre serviços', template: '%s · CoJam' },
    description,
    applicationName: 'CoJam',
    alternates: { canonical: '/' },
    openGraph: {
      type: 'website',
      siteName: 'CoJam',
      title: 'CoJam · ouçam juntos, entre serviços',
      description,
      url: siteUrl,
      locale: 'pt_BR',
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
  // Android Chrome resizes the layout viewport for the keyboard (iOS Safari ignores
  // this; useVisualViewportHeight covers it), so the chat composer stays visible.
  interactiveWidget: 'resizes-content',
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
    inLanguage: 'pt-BR',
    url: siteUrl,
    description,
  };
  return (
    <html lang="pt-BR" className={`dark ${display.variable} ${body.variable}`}>
      <head>
        {/* Runtime client config (WS URL, Spotify client id). Loaded before the
            app so window.__COJAM_ENV__ is set when realtime/auth code runs. */}
        <Script src="/env.js" strategy="beforeInteractive" />
      </head>
      <body>
        <WebVitals />
        <a href="#main" className="sr-only focus:not-sr-only">
          Pular para o conteúdo
        </a>
        {children}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
        />
      </body>
    </html>
  );
}
