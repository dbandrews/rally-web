// tools/vite-orig-assets.mjs — Vite plugin: the original-asset manifest is OPTIONAL (docs/ASSETS.md).
//
// public/assets/ (built by `npm run assets`) is gitignored, so CI, tests and fresh clones have no
// public/assets/manifest.json. Without help the runtime's manifest fetch would 404 and the browser would
// log a console error. This plugin makes "no assets" a clean, silent state:
//   * dev server: GET <base>assets/manifest.json answers `null` (200, application/json) while the file is
//     missing (checked per request, so a build run while the server is up is picked up without a restart);
//   * vite build: emits assets/manifest.json = `null` when public/assets/manifest.json does not exist (the
//     public copy wins otherwise).
// src/core/assets.ts treats `null` as "no original assets" (procedural fallback, no warning).
//
// public/sound/ is the user's OWN copy of the licensed third-party soundtrack (read only with ?music=1,
// src/audio/orig/music.ts; gitignored). Vite copies public/ into the build, so closeBundle removes
// <outDir>/sound/ again: the music never ships in a build.
import fs from 'node:fs';
import path from 'node:path';

export function origAssets() {
  let root = process.cwd();
  let publicDir = path.join(root, 'public');
  let outDir = path.join(root, 'dist');
  let building = false;
  const manifestFile = () => path.join(publicDir, 'assets', 'manifest.json');
  return {
    name: 'rally-orig-assets',
    configResolved(config) {
      root = config.root;
      publicDir = config.publicDir || path.join(root, 'public');
      outDir = path.resolve(root, config.build?.outDir || 'dist');
      building = config.command === 'build';
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.endsWith('/assets/manifest.json') || fs.existsSync(manifestFile())) return next();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end('null');
      });
    },
    generateBundle() {
      if (!fs.existsSync(manifestFile())) this.emitFile({ type: 'asset', fileName: 'assets/manifest.json', source: 'null' });
    },
    closeBundle() {
      // only the build output: never the source public/sound/ (outDir must not be the public dir itself)
      if (!building || path.resolve(outDir) === path.resolve(publicDir)) return;
      const sound = path.join(outDir, 'sound');
      if (fs.existsSync(sound)) fs.rmSync(sound, { recursive: true, force: true });
    },
  };
}
