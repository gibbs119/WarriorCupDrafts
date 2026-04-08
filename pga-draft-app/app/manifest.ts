import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Warrior Cup Drafts',
    short_name: 'Warrior Cup',
    description: 'Snake draft fantasy golf — The Players & all 4 Majors',
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#030912',
    theme_color: '#030912',
    orientation: 'portrait',
    scope: '/',
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  };
}
