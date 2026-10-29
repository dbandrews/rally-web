// tools/lib/harness.mjs — ARCHITECT-OWNED shared Playwright + Vite harness for smoke.mjs / drive.mjs.
// Builders may import it from their own tools; do not change existing exports.
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** WebGL2 in headless chromium via SwiftShader. */
export const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

/** Console noise that is not an app error (software GL, devtools hints). Extend with care. */
export const IGNORED_CONSOLE = [
  /GPU stall due to ReadPixels/i,
  /Automatic fallback to software WebGL/i,
  /WebGL: too many errors/i,
  /\[\.WebGL-[^\]]*\]\s*GL Driver Message/i,
  /Download the React DevTools/i,
];

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Start the Vite dev server programmatically on a free port. Returns { url, close }. */
export async function startServer({ port } = {}) {
  const { createServer } = await import('vite');
  const p = port ?? (await freePort());
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    clearScreen: false,
    server: { port: p, strictPort: true, host: '127.0.0.1', hmr: false },
  });
  await server.listen();
  return { url: `http://127.0.0.1:${p}/`, close: () => server.close() };
}

export async function launchBrowser({ headed = false } = {}) {
  return chromium.launch({ headless: !headed, args: CHROMIUM_ARGS });
}

/**
 * Open the game page and collect errors. Returns { page, errors, warnings, logs, ignored }.
 * errors: console 'error' messages (minus IGNORED_CONSOLE) + uncaught page errors + failed requests.
 */
export async function openGame(browser, baseUrl, query = {}, { width = 1280, height = 720 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  const warnings = [];
  const logs = [];
  const ignored = [];
  page.on('console', (msg) => {
    const text = msg.text();
    const type = msg.type();
    if (type === 'error') {
      if (IGNORED_CONSOLE.some((r) => r.test(text))) ignored.push(text);
      else errors.push(`console.error: ${text}`);
    } else if (type === 'warning') {
      if (IGNORED_CONSOLE.some((r) => r.test(text))) ignored.push(text);
      else warnings.push(text);
    } else if (logs.length < 200) logs.push(`${type}: ${text}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}\n${err.stack ?? ''}`.trim()));
  page.on('requestfailed', (req) => {
    const u = req.url();
    if (!u.includes('favicon')) errors.push(`requestfailed: ${u} ${req.failure()?.errorText ?? ''}`);
  });
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
  const url = `${baseUrl}?${qs.toString()}`;
  await page.goto(url, { waitUntil: 'load' });
  return { context, page, url, errors, warnings, logs, ignored };
}

/** Wait until window.__rally.ready (survives one Vite dep-optimisation reload). */
export async function waitReady(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      await page.waitForFunction(() => (window.__rally && window.__rally.ready === true) || !!document.querySelector('#loading.error'), null, {
        timeout: Math.max(1000, deadline - Date.now()),
        polling: 100,
      });
      const failed = await page.evaluate(() => document.querySelector('#loading.error')?.textContent ?? null);
      if (failed) throw new Error(`game failed to start: ${failed}`);
      return;
    } catch (e) {
      lastErr = e;
      if (/game failed to start/.test(String(e))) throw e;
      if (!/Execution context was destroyed|navigation/i.test(String(e))) break;
    }
  }
  const loadingText = await page.evaluate(() => document.getElementById('loading')?.textContent ?? null).catch(() => null);
  throw new Error(`game not ready within ${timeoutMs} ms (loading text: ${JSON.stringify(loadingText)}): ${lastErr}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal --flag value parser: --a 1 --b --c=x  ->  { a: '1', b: true, c: 'x' }; repeated flags -> arrays. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    let key = a.slice(2);
    let val = true;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      val = argv[++i];
    }
    if (key in out) out[key] = [].concat(out[key], val);
    else out[key] = val;
  }
  return out;
}
