import type { Plugin } from 'vite';

/** Vite plugin: serve / emit `null` for assets/manifest.json while public/assets/ is absent (docs/ASSETS.md); keeps
 *  public/sound/ (the user's own soundtrack copy) out of `vite build` output. */
export function origAssets(): Plugin;
