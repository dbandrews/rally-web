// vite.config.ts — ARCHITECT-OWNED. Vite dev/build + vitest configuration.
import { defineConfig } from 'vitest/config';
import { origAssets } from './tools/vite-orig-assets.mjs';

export default defineConfig({
  // relative asset URLs, so the same build works at a site root and under GitHub Pages' /rally-web/ path
  base: './',
  // public/assets/ (original assets, `npm run assets`) is optional: a missing manifest is served as `null`
  plugins: [origAssets()],
  server: {
    host: true,
    // never served: the extracted archives, research data and the Python venv (tens of thousands of files)
    watch: { ignored: ['**/.cache/**', '**/research/**', '**/original_version/**', '**/.venv/**'] },
  },
  // pre-bundle at server start so the first page load never triggers a "deps optimized, reloading" cycle
  // (tools/smoke.mjs and tools/drive.mjs rely on a stable first load)
  optimizeDeps: { include: ['three', 'lil-gui'] },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 2000 },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
});
