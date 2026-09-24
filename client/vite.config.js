import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // The worker is written by hand in src/sw.js rather than generated: it has to
      // receive notifications while the app is closed, which a generated one cannot do.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon.svg'],
      manifest: {
        name: 'Jarvis',
        short_name: 'Jarvis',
        description: 'Your personal AI agents',
        theme_color: '#0b0a1a',
        background_color: '#0b0a1a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // The list of files the worker precaches. (The /api rule that used to live here is
      // now a line in src/sw.js, because a hand-written worker sets up its own routes.)
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
      // So notifications can be tried on localhost during development, not only once live.
      devOptions: { enabled: true, type: 'module', suppressWarnings: true },
    }),
  ],
  server: {
    proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: true } },
  },
});
