import type { MetadataRoute } from 'next';

// Palco ink, the ground of every non-room screen. theme_color and
// background_color must match the viewport themeColor in layout.tsx.
const PWA_INK = '#0d0a17';

const PWA_DESCRIPTION =
  'Amigos em serviços de streaming diferentes ouvem juntos numa só sala. Cada um toca na própria conta; o CoJam mantém a fila em sincronia só com metadados.';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'CoJam',
    short_name: 'CoJam',
    description: PWA_DESCRIPTION,
    lang: 'pt-BR',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: PWA_INK,
    theme_color: PWA_INK,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
