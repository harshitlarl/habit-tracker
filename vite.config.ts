import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// `base` is injected by the deploy workflow (GitHub Pages uses BASE_PATH=/habit-tracker/).
// Everything asset-related must stay base-aware: never hardcode "/icons/..." inside JS —
// use `import.meta.env.BASE_URL` instead.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  build: {
    // The Firebase SDK is reached only through the dynamic imports in src/lib/sync/firebase.ts
    // (SPEC §13.1), so it already lands outside the entry chunk; naming the group keeps that split
    // visible in dist/ (firebase-[hash].js) and the chunk is never modulepreloaded by index.html.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'firebase', test: /node_modules[\\/](?:@firebase|firebase)[\\/]/ }],
        },
      },
    },
    // That lazy chunk is ~700 kB minified (Firestore alone is most of it); the entry stays well under the default 500 kB.
    chunkSizeWarningLimit: 800,
  },
  plugins: [
    react(),
    VitePWA({
      // New builds install silently and take over on the next launch.
      registerType: 'autoUpdate',
      // Precache the two public icons the manifest does not list; manifest icons are added
      // automatically (includeManifestIcons defaults to true). scope and start_url are left
      // unset on purpose: the plugin derives both from `base`.
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon.svg'],
      manifest: {
        name: 'Momentum',
        short_name: 'Momentum',
        description:
          'A calm personal habit tracker. Check off your trackers each day, keep your streaks, and see the week take shape.',
        lang: 'en',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#F4EEE2',
        background_color: '#F4EEE2',
        icons: [
          { src: 'icons/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/pwa-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // woff2 keeps the self-hosted Fraunces / Hanken Grotesk files available offline.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // public/icons/* already enter the precache via includeAssets + manifest icons;
        // globbing them too would list every icon twice.
        globIgnores: ['**/node_modules/**/*', 'icons/**'],
        maximumFileSizeToCacheInBytes: 4_000_000,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
  ],
});
