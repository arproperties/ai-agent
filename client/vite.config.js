import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { copyFileSync, createReadStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// "Hey Buddy" runs its speech models in the browser with ONNX Runtime, loaded at runtime from
// /heybuddy/ort/ (src/lib/wakeword.js). The engine is 11 MB of WASM, so it is taken from
// node_modules rather than committed: served from there in dev, copied into dist on a build.
const ORT_DIR = fileURLToPath(new URL('./node_modules/onnxruntime-web/dist/', import.meta.url));
const ORT_FILES = ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
const heyBuddyRuntime = () => ({
  name: 'hey-buddy-runtime',
  configureServer(server) {
    server.middlewares.use('/heybuddy/ort', (req, res, next) => {
      const file = req.url.split('?')[0].replace(/^\//, '');
      if (!ORT_FILES.includes(file)) return next();
      res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      createReadStream(join(ORT_DIR, file)).pipe(res);
    });
  },
  writeBundle({ dir }) {
    if (!dir) return;
    mkdirSync(join(dir, 'heybuddy/ort'), { recursive: true });
    for (const f of ORT_FILES) copyFileSync(join(ORT_DIR, f), join(dir, 'heybuddy/ort', f));
  },
});

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    heyBuddyRuntime(),
    VitePWA({
      // The worker is written by hand in src/sw.js rather than generated: it has to
      // receive notifications while the app is closed, which a generated one cannot do.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      // A new version waits until the person taps Update (src/lib/update.js), never reloads by itself.
      registerType: 'prompt',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon.svg'],
      manifest: {
        name: 'Reem',
        short_name: 'Reem',
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
    // Drawings are drawn by server/drawingCore.js, shared with the server: let the dev server read it.
    fs: { allow: ['..'] },
    proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: true } },
  },
});
