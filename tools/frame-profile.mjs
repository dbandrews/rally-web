#!/usr/bin/env node
// tools/frame-profile.mjs — frame-pacing / hitch profiler for the PRODUCTION build (node tools/frame-profile.mjs).
//
// Serves dist/ (run `npm run build` first; it includes public/assets/) from a small static server that mimics GitHub
// Pages (served under /rally-web/, gzip for text types, ETag/Last-Modified, Cache-Control: max-age=600, Range), opens
// /rally-web/?stage=<id>&menu=0&autopilot=1 in headless chromium (SwiftShader WebGL2), lets the real countdown run,
// drives with the autopilot for --seconds of RACE time, and records from page load on:
//   * every rAF timestamp, the JS time of the rAF callbacks, the JS heap (precise-memory-info) and three.js
//     renderer.info (programs / textures / geometries / draw calls; window.__rally.getRenderInfo, debug-only accessor);
//   * a timed wrapper around the hitch-prone WebGL2 calls (linkProgram, compileShader, getProgramParameter, texImage2D,
//     compressedTexImage2D, bufferData, generateMipmap, readPixels, ...) with counts / ms / bytes per frame window;
//     wrappers on JSON.parse (>= 1 ms) and AudioContext.decodeAudioData;
//   * PerformanceObserver: 'longtask', 'long-animation-frame' (script attributions), 'resource' (name, start,
//     responseEnd, transfer/encoded size), a MutationObserver count (DOM churn).
// CDP throttling (page-level): Network.emulateNetworkConditions (--net none|5g|slow) with the HTTP cache disabled for
// first-visit runs (--cache cold, default), Emulation.setCPUThrottlingRate (--cpu 1|4), optional --mobile (390x844,
// isMobile, hasTouch, dsf 2).
//
// Frame i's "window" is [cb(i-1) start, cb(i) start): what made rAF interval dt(i) long (the tail of the previous rAF
// callback + the tasks that ran in the gap). For every frame whose dt > 2x median dt (and, separately, JS time > 2x
// median JS time) the JSON lists the coincident events inside that window: resource responseEnd, programs / textures /
// geometries increments, WebGL call time, long tasks / LoAF scripts, heap drops (GC), JSON.parse / decodeAudioData,
// DOM mutations, and a heuristic classification. It also lists ALL resource requests that started after the race did.
//
// HONEST LIMITS: headless chromium here renders with SwiftShader (software GL), so ABSOLUTE frame times and the GPU
// share are meaningless (dt is dominated by software rasterisation; GPU-side shader compile / texture upload cost is
// hidden in a real GPU driver and under-reported here). What the profile is good for: WHICH main-thread work happens
// after the race started and coincides with long frames. Run with --size 480x270 to shrink the software-raster share.
//
// Output (stable schema 'frame-profile/1', diff-friendly): <out>/<label>.json per run and <out>/summary.json +
// summary.txt over the whole matrix. Comma lists (--stage a,b --net none,5g --cpu 1,4) run the cross product.
// Options: --stage <id[,id]> (default newzealand-2-f)  --net none|5g|slow  --cpu 1|4  --mobile  --seconds 45 (race s)
//          --cache cold|warm  --ai <0..3>  --audio 1|0 (default 1)  --size WxH (default 960x540)  --out <dir>
//          --quality low|medium|high|auto (the ?quality= URL param; headless SwiftShader otherwise pins 'low' with pixel
//          ratio 0.6, which hides the shadow / high-quality material variants a real GPU renders; 'auto' = real-GPU
//          behaviour incl. adaptive step-downs)
//          --dist <dir> (default dist)  --url <base> (use a running server instead)  --gzip 0|1 (default 1)
//          --max-wall <s> (per-run wall cap, default seconds*8+120)  --headed  --query k=v  --label <prefix>
//          --alloc (CDP sampling heap profiler during the race, incl. collected objects: top allocation sites = the GC garbage
//          producers; adds overhead)
//          --cpuprofile (CDP sampling CPU profiler during the race, 1 ms interval: top self-time functions mapped to src/ via the
//          build's source map; adds overhead)
//          --eval <js expression> (evaluated in the page after the run; result appended to errors[] — debugging aid)
//          --trace (chromium tracing, devtools.timeline+v8: exact MinorGC / MajorGC pauses per long frame; adds overhead,
//          use for attribution runs, not for absolute numbers)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { SourceMap } from 'node:module';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import { CHROMIUM_ARGS, IGNORED_CONSOLE, ROOT, freePort, parseArgs, sleep } from './lib/harness.mjs';

const SCHEMA = 'frame-profile/1';
const BASE_PATH = '/rally-web/';
const NETS = {
  none: null,
  // 5G: 40 ms RTT, ~25 Mbit/s down, 5 Mbit/s up
  '5g': { latency: 40, downloadThroughput: (25 * 1e6) / 8, uploadThroughput: (5 * 1e6) / 8 },
  // slow: 120 ms RTT, ~6 Mbit/s down
  slow: { latency: 120, downloadThroughput: (6 * 1e6) / 8, uploadThroughput: (1 * 1e6) / 8 },
};

// ------------------------------------------------------------------------------------------------ static server

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.wav': 'audio/wav', '.bin': 'application/octet-stream',
  '.rtex': 'application/octet-stream', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon',
};
const GZIP_TYPES = /^(text\/|application\/json|application\/javascript|image\/svg|application\/manifest)/;

/** GitHub-Pages-like static server for dist/ under /rally-web/. Returns { url, close, stats }. */
async function startStatic(distDir, { gzip = true } = {}) {
  const port = await freePort();
  const stats = { requests: 0, bytes: 0 };
  const gzCache = new Map();
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (!p.startsWith(BASE_PATH)) {
      res.writeHead(404).end('not found');
      return;
    }
    p = p.slice(BASE_PATH.length);
    if (p === '' || p.endsWith('/')) p += 'index.html';
    const file = path.join(distDir, p);
    if (!file.startsWith(distDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    const st = fs.statSync(file);
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    const etag = `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': type,
      'Cache-Control': 'max-age=600',
      ETag: etag,
      'Last-Modified': st.mtime.toUTCString(),
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    };
    stats.requests++;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers).end();
      return;
    }
    const wantGz = gzip && GZIP_TYPES.test(type) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    if (wantGz) {
      let buf = gzCache.get(file);
      if (!buf) gzCache.set(file, (buf = zlib.gzipSync(fs.readFileSync(file), { level: 6 })));
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': buf.length, Vary: 'Accept-Encoding' });
      stats.bytes += buf.length;
      res.end(buf);
      return;
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (m) {
      const start = m[1] === '' ? Math.max(0, st.size - Number(m[2])) : Number(m[1]);
      const end = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(st.size - 1, Number(m[2]));
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      stats.bytes += end - start + 1;
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    stats.bytes += st.size;
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}${BASE_PATH}`, close: () => new Promise((r) => server.close(r)), stats };
}

// ------------------------------------------------------------------------------------------------ in-page instrumentation

/** Serialised into the page by addInitScript (must be self-contained). */
function instrument() {
  const P = {
    samples: [], // one per rAF tick: { t, p, heap, prog, tex, geo, calls, tri, ph, gl, mut, js }
    longtasks: [],
    loaf: [],
    resources: [],
    events: [], // { k, t, ms, n }
    readyAt: null,
    raceStartIdx: -1,
    raceTime: 0,
    phase: null,
    err: [],
  };
  window.__prof = P;
  const now = () => performance.now();
  try { performance.setResourceTimingBufferSize(20000); } catch {}

  // ---- WebGL2 call timing
  let gl = {};
  P.takeGl = () => { const g = gl; gl = {}; return g; };
  const bytesOf = (a) => {
    for (let i = a.length - 1; i >= 0; i--) {
      const x = a[i];
      if (x && typeof x === 'object') {
        if (typeof x.byteLength === 'number') return x.byteLength;
        if (typeof x.width === 'number' && typeof x.height === 'number') return x.width * x.height * 4;
      }
    }
    return 0;
  };
  const names = [
    'linkProgram', 'compileShader', 'getProgramParameter', 'getShaderParameter', 'getProgramInfoLog', 'getShaderInfoLog',
    'useProgram', 'createProgram', 'createShader', 'createTexture', 'createBuffer', 'texImage2D', 'texSubImage2D',
    'texImage3D', 'texSubImage3D', 'texStorage2D', 'texStorage3D', 'compressedTexImage2D', 'compressedTexSubImage2D',
    'generateMipmap', 'bufferData', 'bufferSubData', 'readPixels', 'finish', 'getError', 'deleteTexture', 'deleteBuffer',
    'deleteProgram', 'createVertexArray', 'blitFramebuffer', 'createFramebuffer',
  ];
  const withBytes = new Set(['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D', 'compressedTexImage2D', 'compressedTexSubImage2D', 'bufferData', 'bufferSubData']);
  const proto = window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype;
  if (proto) {
    for (const n of names) {
      const orig = proto[n];
      if (typeof orig !== 'function') continue;
      proto[n] = function () {
        const t0 = now();
        const r = orig.apply(this, arguments);
        const dt = now() - t0;
        let e = gl[n];
        if (!e) e = gl[n] = [0, 0, 0];
        e[0]++;
        e[1] += dt;
        if (withBytes.has(n)) e[2] += bytesOf(arguments);
        return r;
      };
    }
  }

  // ---- JSON.parse and audio decode
  const jp = JSON.parse;
  JSON.parse = function (text) {
    const t0 = now();
    const r = jp.apply(this, arguments);
    const ms = now() - t0;
    if (ms >= 1) P.events.push({ k: 'json', t: t0, ms, n: typeof text === 'string' ? text.length : 0 });
    return r;
  };
  for (const C of [window.AudioContext, window.webkitAudioContext, window.OfflineAudioContext]) {
    const dd = C && C.prototype && C.prototype.decodeAudioData;
    if (!dd) continue;
    C.prototype.decodeAudioData = function (buf) {
      const t0 = now();
      const n = buf && buf.byteLength;
      const p = dd.apply(this, arguments);
      // main-thread cost of the call itself; the decode runs off-thread and resolves later
      P.events.push({ k: 'decodeStart', t: t0, ms: now() - t0, n });
      if (p && p.then) p.then(() => P.events.push({ k: 'decodeDone', t: now(), ms: now() - t0, n }), () => {});
      return p;
    };
  }

  // ---- console info / warn (e.g. "[render] 31 fps -> quality medium": adaptive quality steps recompile every material)
  for (const lvl of ['info', 'warn', 'log']) {
    const o = console[lvl];
    console[lvl] = function () {
      try {
        if (P.events.length < 5000 && typeof arguments[0] === 'string' && /^\[(render|orig|audio|ai|ghost)/i.test(arguments[0])) P.events.push({ k: 'console:' + lvl, t: now(), ms: 0, n: 0, msg: String(arguments[0]).slice(0, 160) });
      } catch {}
      return o.apply(this, arguments);
    };
  }

  // ---- DOM churn
  let mut = 0;
  P.takeMut = () => { const m = mut; mut = 0; return m; };
  const startMo = () => {
    try {
      new MutationObserver((l) => { for (const r of l) mut += 1 + (r.addedNodes ? r.addedNodes.length : 0) + (r.removedNodes ? r.removedNodes.length : 0); })
        .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch {}
  };
  startMo();

  // ---- performance observers
  const obs = (type, cb, opts) => {
    try {
      new PerformanceObserver((l) => l.getEntries().forEach(cb)).observe({ type, buffered: true, ...opts });
      return true;
    } catch { return false; }
  };
  P.supports = {
    longtask: obs('longtask', (e) => P.longtasks.push({ start: e.startTime, dur: e.duration })),
    loaf: obs('long-animation-frame', (e) =>
      P.loaf.push({
        start: e.startTime, dur: e.duration, blocking: e.blockingDuration, renderStart: e.renderStart,
        styleStart: e.styleAndLayoutStart, forcedStyleLayout: e.firstUIEventTimestamp ? 0 : 0,
        scripts: (e.scripts || []).map((s) => ({
          src: s.sourceURL, fn: s.sourceFunctionName, invoker: s.invoker, type: s.invokerType, dur: s.duration,
          start: s.startTime, forced: s.forcedStyleAndLayoutDuration, pause: s.pauseDuration,
        })),
      })),
    resource: obs('resource', (e) =>
      P.resources.push({
        name: e.name, init: e.initiatorType, start: e.startTime, end: e.responseEnd, reqStart: e.requestStart,
        respStart: e.responseStart, transfer: e.transferSize, enc: e.encodedBodySize, dec: e.decodedBodySize,
      })),
  };

  // ---- rAF wrapper: one sample per distinct timestamp
  let cur = null;
  const origRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    origRaf((ts) => {
      const p0 = now();
      if (!cur || cur.t !== ts) {
        const api = window.__rally;
        let info = null;
        try { info = api && api.getRenderInfo ? api.getRenderInfo() : null; } catch {}
        let progNew = null;
        if (info && P.lastProg !== undefined && info.programs !== P.lastProg) {
          try {
            const names = api.getRenderInfo(true).programNames || [];
            progNew = names.filter((n) => !(P.seenProg || (P.seenProg = new Set())).has(n));
            names.forEach((n) => P.seenProg.add(n));
          } catch {}
        } else if (info && P.lastProg === undefined) {
          try { P.seenProg = new Set(api.getRenderInfo(true).programNames || []); } catch {}
        }
        if (info) P.lastProg = info.programs;
        const pm = performance.memory;
        if (api && api.ready && P.readyAt === null) P.readyAt = p0;
        if (api && api.ready && P.raceStartIdx < 0) {
          try {
            const rs = api.getRaceState();
            P.phase = rs.phase;
            if (rs.phase === 'running') P.raceStartIdx = P.samples.length;
          } catch {}
        }
        cur = {
          t: ts, p: p0, heap: pm ? pm.usedJSHeapSize : 0, prog: info ? info.programs : -1, tex: info ? info.textures : -1,
          geo: info ? info.geometries : -1, calls: info ? info.calls : -1, tri: info ? info.triangles : -1,
          ph: P.phase, progNew, gl: P.takeGl(), mut: P.takeMut(), js: 0,
        };
        P.samples.push(cur);
      }
      const s = cur;
      try { cb(ts); } finally { s.js += now() - p0; }
    });
  // race time (cheap, ~2 Hz) so the driver can stop at N seconds of race time
  setInterval(() => {
    try { if (window.__rally && window.__rally.ready) { const rs = window.__rally.getRaceState(); P.raceTime = rs.time; P.phase = rs.phase; } } catch {}
  }, 500);
}

// ------------------------------------------------------------------------------------------------ analysis

const round = (x, d = 2) => (Number.isFinite(x) ? +x.toFixed(d) : x);
function pct(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}
function dist(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
  return { n: s.length, mean: round(mean), p50: round(pct(s, 0.5)), p95: round(pct(s, 0.95)), p99: round(pct(s, 0.99)), max: round(s[s.length - 1] ?? 0) };
}
const shortUrl = (u) => {
  try { return new URL(u).pathname.replace(BASE_PATH, ''); } catch { return u; }
};
const kindOf = (u) => {
  const p = shortUrl(u);
  if (/\.rtex$/.test(p)) return 'texture';
  if (/\.wav$|\.ogg$|\.mp3$/.test(p)) return 'audio';
  if (/stages\/[^/]+\/.*\.(json|bin)$/.test(p)) return 'stage-data';
  if (/^assets\/cars\//.test(p)) return 'car';
  if (/\.js$|\.css$|\.html$/.test(p)) return 'app';
  if (/\.json$|\.bin$/.test(p)) return 'data';
  return 'other';
};

function analyse(raw, cfg, extra) {
  const S = raw.samples;
  const startIdx = raw.raceStartIdx;
  const out = { schema: SCHEMA, config: cfg, notes: [] };
  const origin = raw.timeOrigin ?? 0;
  void origin;

  // ---- load timeline
  const readyP = raw.readyAt ?? 0;
  const resReady = raw.resources.filter((r) => r.end <= readyP);
  out.load = {
    timeToReadyMs: round(extra.readyWallMs, 0),
    readyAtPageMs: round(readyP, 0),
    requestsAtReady: resReady.length,
    bytesAtReady: resReady.reduce((a, r) => a + (r.transfer || r.enc || 0), 0),
    decodedBytesAtReady: resReady.reduce((a, r) => a + (r.dec || 0), 0),
    byKindAtReady: groupKinds(resReady),
    totalRequests: raw.resources.length,
    totalTransferBytes: raw.resources.reduce((a, r) => a + (r.transfer || r.enc || 0), 0),
    serverRequests: extra.server ? extra.server.requests : null,
  };
  if (startIdx < 0 || S.length < 10) {
    out.notes.push('race never reached phase=running');
    out.race = null;
    out.errors = extra.errors;
    return out;
  }

  // ---- race frames. dt(i) = t(i) - t(i-1) for i > startIdx (frame i's window is cb(i-1) start .. cb(i) start)
  const first = startIdx + 1;
  const dts = [];
  for (let i = first; i < S.length; i++) dts.push(S[i].t - S[i - 1].t);
  const jsPrev = []; // JS time of the previous callback (the one whose tail + gap produced dt)
  for (let i = first; i < S.length; i++) jsPrev.push(S[i - 1].js);
  const med = pct([...dts].sort((a, b) => a - b), 0.5);
  const medJs = pct([...jsPrev].sort((a, b) => a - b), 0.5);
  const raceStartP = S[startIdx].p;
  const raceStartR = S[startIdx].t; // rAF timestamps share the performance.now() origin
  const raceEndP = S[S.length - 1].p;
  const longThr = 2 * med;
  const jsThr = Math.max(2 * medJs, medJs + 8);

  const programsAdded = S[S.length - 1].prog - S[startIdx].prog;
  const tex0 = S[startIdx].tex, geo0 = S[startIdx].geo;
  const rowsLong = [];
  let nLongDt = 0, nLongJs = 0;
  const heapDrops = [];
  for (let i = first; i < S.length; i++) {
    const dt = S[i].t - S[i - 1].t;
    const js = S[i - 1].js;
    const isLongDt = dt > longThr;
    const isLongJs = js > jsThr;
    const w0 = S[i - 1].p, w1 = S[i].p; // window
    const dHeap = S[i].heap - S[i - 1].heap;
    if (dHeap < -1e6) heapDrops.push({ i: i - first, t: round(w1 - raceStartP, 0), mb: round(dHeap / 1e6) });
    if (isLongDt) nLongDt++;
    if (isLongJs) nLongJs++;
    if (!isLongDt && !isLongJs) continue;
    const res = raw.resources.filter((r) => r.end >= w0 && r.end < w1).map((r) => ({ url: shortUrl(r.name), kind: kindOf(r.name), kb: round((r.transfer || r.enc || 0) / 1024, 1), startedMsBeforeEnd: round(r.end - r.start, 0) }));
    const lt = raw.longtasks.filter((l) => l.start + l.dur >= w0 && l.start < w1).map((l) => ({ start: round(l.start - w0, 0), dur: round(l.dur, 0) }));
    const lo = raw.loaf.filter((l) => l.start + l.dur >= w0 && l.start < w1).map((l) => ({
      dur: round(l.dur, 0), blocking: round(l.blocking, 0), preRender: round(l.renderStart - l.start, 0), styleLayout: l.styleStart ? round(l.start + l.dur - l.styleStart, 0) : 0,
      scripts: l.scripts.slice(0, 4).map((s) => `${shortUrl(s.src || '')}:${s.fn || s.invoker || ''} ${round(s.dur, 0)}ms${s.forced ? ` forced-layout ${round(s.forced, 0)}ms` : ''}`),
    }));
    const gcs = (extra.gcEvents || []).filter((e) => e.t >= w0 && e.t < w1);
    const ev = raw.events.filter((e) => e.t >= w0 && e.t < w1).map((e) => (e.msg ? `${e.k}: ${e.msg}` : `${e.k}${e.n ? `(${e.n})` : ''} ${round(e.ms)}ms`));
    const g = S[i].gl; // GL calls recorded in this window (flushed at cb(i) start)
    const glSum = {};
    let glMs = 0, texUploadMs = 0, progMs = 0;
    for (const [k, v] of Object.entries(g)) {
      glSum[k] = [v[0], round(v[1]), v[2]];
      glMs += v[1];
      if (/^(tex|compressedTex|generateMipmap)/.test(k)) texUploadMs += v[1];
      if (/Program|Shader|compile/.test(k)) progMs += v[1];
    }
    const dProg = S[i].prog - S[i - 1].prog, dTex = S[i].tex - S[i - 1].tex, dGeo = S[i].geo - S[i - 1].geo;
    const cls = [];
    if (res.length) cls.push('network-completion');
    if (dProg > 0 || (g.linkProgram && g.linkProgram[0] > 0)) cls.push('shader-compile');
    if (dTex > 0 || texUploadMs > 2) cls.push('texture-upload');
    if (dGeo > 0 || (g.bufferData && g.bufferData[1] > 2)) cls.push('geometry-upload');
    if (dHeap < -1e6 || gcs.length) cls.push('gc');
    if (lo.some((l) => l.styleLayout > 5)) cls.push('dom-style-layout');
    if (raw.events.some((e) => e.msg && e.t >= w0 && e.t < w1 && /quality/.test(e.msg))) cls.push('quality-step');
    if (ev.length) cls.push('json/audio/console');
    if (S[i].mut > 20) cls.push('dom-mutations');
    if (!cls.length) cls.push(isLongJs ? 'per-frame-cpu' : 'unattributed(gpu/vsync/swiftshader)');
    rowsLong.push({
      frame: i - first, tMs: round(w1 - raceStartP, 0), dt: round(dt), x: round(dt / med, 1), jsPrevMs: round(js), longDt: isLongDt, longJs: isLongJs,
      class: cls, newPrograms: S[i].progNew || undefined, resources: res, programsDelta: dProg, texturesDelta: dTex, geometriesDelta: dGeo,
      heapDeltaMB: round(dHeap / 1e6), gc: gcs.length ? gcs.map((g) => `${g.kind} ${round(g.dur)}ms`) : undefined, gl: glSum, glMs: round(glMs), mutations: S[i].mut, longtasks: lt, loaf: lo, events: ev,
      calls: S[i - 1].calls,
    });
  }

  const raceFrames = S.slice(first);
  const increments = [];
  for (let i = first; i < S.length; i++) {
    const dP = S[i].prog - S[i - 1].prog, dT = S[i].tex - S[i - 1].tex, dG = S[i].geo - S[i - 1].geo;
    if (dP > 0 || dT > 0 || dG > 0)
      increments.push({ frame: i - first, tMs: round(S[i].p - raceStartP, 0), dt: round(S[i].t - S[i - 1].t), dPrograms: dP, dTextures: dT, dGeometries: dG, newPrograms: S[i].progNew || undefined });
  }
  const raceSecs = (raceEndP - raceStartP) / 1000;
  out.race = {
    raceTimeS: round(raw.raceTime, 1),
    wallS: round(raceSecs, 1),
    frames: dts.length,
    fps: round(dts.length / Math.max(1e-6, raceSecs), 1),
    dtMs: dist(dts),
    jsMs: dist(jsPrev),
    medianDt: round(med),
    longFrameThresholdMs: round(longThr),
    framesOver2xMedian: nLongDt,
    framesOver2xMedianPct: round((100 * nLongDt) / Math.max(1, dts.length), 1),
    framesOver50ms: dts.filter((d) => d > 50).length,
    framesOver100ms: dts.filter((d) => d > 100).length,
    jsLongThresholdMs: round(jsThr),
    framesJsOverThreshold: nLongJs,
    // hitch-ness independent of the raster cost: dt minus the median (ms above the typical frame)
    excessOverMedianMsTotal: round(dts.reduce((a, d) => a + Math.max(0, d - med), 0), 0),
    heapMB: { start: round(S[startIdx].heap / 1e6, 1), end: round(S[S.length - 1].heap / 1e6, 1), max: round(Math.max(...raceFrames.map((f) => f.heap)) / 1e6, 1) },
    heapDrops: { count: heapDrops.length, totalMB: round(heapDrops.reduce((a, d) => a + d.mb, 0)), list: heapDrops.slice(0, 60) },
    allocMBPerSec: round(Math.max(0, S[S.length - 1].heap - S[startIdx].heap + heapDrops.reduce((a, d) => a - d.mb * 1e6, 0)) / 1e6 / Math.max(1e-6, raceSecs), 2),
    rendererDelta: {
      programs: programsAdded, textures: S[S.length - 1].tex - tex0, geometries: S[S.length - 1].geo - geo0,
      programsAtStart: S[startIdx].prog, texturesAtStart: tex0, geometriesAtStart: geo0, programsAtEnd: S[S.length - 1].prog,
      drawCallsMedian: round(pct(raceFrames.map((f) => f.calls).sort((a, b) => a - b), 0.5), 0),
    },
    longtasks: { count: raw.longtasks.filter((l) => l.start >= raceStartP).length, totalMs: round(raw.longtasks.filter((l) => l.start >= raceStartP).reduce((a, l) => a + l.dur, 0), 0) },
    loafCount: raw.loaf.filter((l) => l.start >= raceStartP).length,
    longtaskList: raw.longtasks.filter((l) => l.start >= raceStartP).slice(0, 300).map((l) => [round(l.start - raceStartP, 0), round(l.dur, 0)]),
    glTotals: sumGl(S.slice(first)),
    glTotalsBeforeRace: sumGl(S.slice(0, first)),
    resourceIncrements: increments.slice(0, 300),
    longFrames: rowsLong.length > 400 ? rowsLong.sort((a, b) => b.dt - a.dt).slice(0, 400).sort((a, b) => a.frame - b.frame) : rowsLong,
    longFramesTruncated: rowsLong.length > 400,
    classCounts: countClasses(rowsLong),
  };

  // ---- requests made after the race started
  const post = raw.resources.filter((r) => r.start >= raceStartR).map((r) => ({
    url: shortUrl(r.name), kind: kindOf(r.name), startMsIntoRace: round(r.start - raceStartR, 0), endMsIntoRace: round(r.end - raceStartR, 0),
    ms: round(r.end - r.start, 0), kb: round((r.transfer || r.enc || 0) / 1024, 1), init: r.init,
  }));
  const spanning = raw.resources.filter((r) => r.start < raceStartR && r.end > raceStartR).map((r) => ({ url: shortUrl(r.name), kind: kindOf(r.name), endMsIntoRace: round(r.end - raceStartR, 0), kb: round((r.transfer || r.enc || 0) / 1024, 1) }));
  out.postStartRequests = { count: post.length, totalKB: round(post.reduce((a, r) => a + r.kb, 0), 0), byKind: groupKinds(raw.resources.filter((r) => r.start >= raceStartR)), list: post, inFlightAtStart: spanning };
  // everything requested after the game was ready (menu-less: sound bank, car/stage extras), times relative to the race start
  const afterReady = raw.resources.filter((r) => r.start >= readyP);
  out.afterReadyRequests = {
    count: afterReady.length,
    totalKB: round(afterReady.reduce((a, r) => a + (r.transfer || r.enc || 0), 0) / 1024, 0),
    byKind: groupKinds(afterReady),
    completedAfterRaceStart: afterReady.filter((r) => r.end > raceStartR).length,
    lastResponseEndMsIntoRace: round(Math.max(...afterReady.map((r) => r.end)) - raceStartR, 0),
    list: afterReady.map((r) => [shortUrl(r.name), round(r.start - raceStartR, 0), round(r.end - raceStartR, 0), round((r.transfer || r.enc || 0) / 1024, 1)]),
  };
  out.preRace = { frames: first, countdownWallS: round((raceStartP - readyP) / 1000, 1), requestsAfterReadyBeforeGo: raw.resources.filter((r) => r.start >= readyP && r.start < raceStartR).length };
  out.consoleEvents = raw.events.filter((e) => e.msg).map((e) => ({ tMs: round(e.t - raceStartP, 0), msg: e.msg }));
  out.pageEvents = { longtasksTotal: raw.longtasks.length, loafTotal: raw.loaf.length, supports: raw.supports, jsonSlow: raw.events.filter((e) => e.k === 'json').length, decodeCalls: raw.events.filter((e) => e.k === 'decodeStart').length };
  if (extra.gcEvents) {
    const g = extra.gcEvents.filter((e) => e.t >= raceStartP);
    const by = {};
    for (const e of g) { by[e.kind] ??= { n: 0, totalMs: 0, maxMs: 0 }; by[e.kind].n++; by[e.kind].totalMs += e.dur; by[e.kind].maxMs = Math.max(by[e.kind].maxMs, e.dur); }
    for (const v of Object.values(by)) { v.totalMs = round(v.totalMs); v.maxMs = round(v.maxMs); }
    out.race.gcTrace = { byKind: by, over4ms: g.filter((e) => e.dur >= 4).map((e) => ({ tMs: round(e.t - raceStartP, 0), kind: e.kind, ms: round(e.dur) })) };
  }
  out.errors = extra.errors;
  // compact series for plotting / diffing (race frames only)
  out.series = { dt: dts.map((d) => round(d, 1)), js: jsPrev.map((d) => round(d, 1)), heapMB: raceFrames.map((f) => round(f.heap / 1e6, 1)), programs: raceFrames.map((f) => f.prog), textures: raceFrames.map((f) => f.tex) };
  return out;
}

function groupKinds(rs) {
  const o = {};
  for (const r of rs) {
    const k = kindOf(r.name);
    o[k] ??= { n: 0, kb: 0 };
    o[k].n++;
    o[k].kb += (r.transfer || r.enc || 0) / 1024;
  }
  for (const v of Object.values(o)) v.kb = round(v.kb, 0);
  return o;
}
function sumGl(samples) {
  const t = {};
  for (const s of samples)
    for (const [k, v] of Object.entries(s.gl)) {
      t[k] ??= { calls: 0, ms: 0, bytes: 0, framesWith: 0, maxMsInOneFrame: 0 };
      t[k].calls += v[0];
      t[k].ms += v[1];
      t[k].bytes += v[2];
      t[k].framesWith++;
      t[k].maxMsInOneFrame = Math.max(t[k].maxMsInOneFrame, v[1]);
    }
  for (const v of Object.values(t)) { v.ms = round(v.ms); v.maxMsInOneFrame = round(v.maxMsInOneFrame); }
  return t;
}
function countClasses(rows) {
  const c = {};
  for (const r of rows) for (const k of r.class) c[k] = (c[k] ?? 0) + 1;
  return c;
}

// ------------------------------------------------------------------------------------------------ one run

async function runOne(browserArgs, baseUrl, cfg, server) {
  const browser = await chromium.launch({ headless: !cfg.headed, args: browserArgs });
  const errors = [];
  try {
    const mobile = cfg.mobile;
    const context = await browser.newContext(
      mobile
        ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
        : { viewport: { width: cfg.size[0], height: cfg.size[1] }, deviceScaleFactor: 1 },
    );
    const page = await context.newPage();
    page.on('console', (m) => {
      const text = m.text();
      if (m.type() === 'error' && !IGNORED_CONSOLE.some((r) => r.test(text))) errors.push(`console.error: ${text}`.slice(0, 300));
    });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`.slice(0, 300)));
    await page.addInitScript(instrument);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {}); // the game auto-pauses on window blur
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: cfg.cache === 'cold' });
    const net = NETS[cfg.net];
    await cdp.send('Network.emulateNetworkConditions', net
      ? { offline: false, latency: net.latency, downloadThroughput: net.downloadThroughput, uploadThroughput: net.uploadThroughput }
      : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    if (cfg.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cfg.cpu });

    const q = new URLSearchParams({ stage: cfg.stage, menu: '0', autopilot: '1', audio: cfg.audio ? '1' : '0' });
    if (cfg.ai) q.set('ai', String(cfg.ai));
    if (cfg.quality) q.set('quality', cfg.quality);
    for (const [k, v] of Object.entries(cfg.query)) q.set(k, v);
    const url = `${baseUrl}?${q}`;
    const reqs0 = server?.stats.requests ?? 0;
    const bytes0 = server?.stats.bytes ?? 0;
    const tNav = Date.now();
    if (cfg.trace) await browser.startTracing(page, { categories: ['devtools.timeline', 'v8'] });
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    const sync = await page.evaluate(() => {
      console.timeStamp('PROF_SYNC');
      return performance.now();
    });
    // ready
    const readyDeadline = Date.now() + cfg.readyTimeoutS * 1000;
    for (;;) {
      const st = await page.evaluate(() => ({ r: window.__rally?.ready === true, f: document.querySelector('#loading.error')?.textContent ?? null })).catch(() => ({ r: false }));
      if (st.f) throw new Error(`game failed to start: ${st.f}`);
      if (st.r) break;
      if (Date.now() > readyDeadline) throw new Error(`not ready within ${cfg.readyTimeoutS} s`);
      await sleep(250);
    }
    const readyWallMs = Date.now() - tNav;
    // the first user gesture starts the audio engine (browser autoplay rules), as a real player's first key does
    if (cfg.audio) await page.keyboard.press('Shift').catch(() => {});
    // drive: wait for race time >= seconds
    const wallCap = Date.now() + cfg.maxWallS * 1000;
    let last = { phase: null, t: 0 };
    let allocOn = false;
    let cpuOn = false;
    let autoPauses = 0;
    for (;;) {
      last = await page.evaluate(() => ({ phase: window.__prof.phase, t: window.__prof.raceTime, n: window.__prof.samples.length }));
      // emulated-mobile pages report a window blur on load and the game auto-pauses mid-countdown: resume (counted)
      if (await page.evaluate(() => { const p = window.__rally.getFrameStats().paused; if (p) window.__rally.pause(false); return p; })) autoPauses++;
      if (cfg.cpuprofile && !cpuOn && last.phase === 'running') {
        cpuOn = true;
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
        await cdp.send('Profiler.start');
      }
      if (cfg.alloc && !allocOn && last.phase === 'running') {
        allocOn = true;
        await cdp.send('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      }
      if (last.phase === 'running' && last.t >= cfg.seconds) break;
      if (last.phase === 'finished') { errors.push('race finished early'); break; }
      if (Date.now() > wallCap) { errors.push(`wall cap hit at raceTime ${last.t}`); break; }
      await sleep(1000);
    }
    if (autoPauses) errors.push(`note: game was auto-paused and resumed ${autoPauses}x by the harness (emulated blur)`);
    const evalResult = typeof cfg.evalExpr === 'string' ? await page.evaluate(cfg.evalExpr).catch((e) => `eval failed: ${e}`) : undefined;
    if (evalResult !== undefined) errors.push(`eval: ${JSON.stringify(evalResult).slice(0, 600)}`);
    let cpuProf = null;
    if (cpuOn) {
      try { cpuProf = (await cdp.send('Profiler.stop')).profile; } catch (e) { errors.push(`cpu profile failed: ${String(e).slice(0, 100)}`); }
    }
    let allocProfile = null;
    if (allocOn) {
      try { allocProfile = (await cdp.send('HeapProfiler.stopSampling')).profile; } catch (e) { errors.push(`alloc profile failed: ${String(e).slice(0, 100)}`); }
    }
    const raw = await page.evaluate(() => {
      const P = window.__prof;
      return { samples: P.samples, longtasks: P.longtasks, loaf: P.loaf, resources: P.resources, events: P.events, readyAt: P.readyAt, raceStartIdx: P.raceStartIdx, raceTime: P.raceTime, supports: P.supports, timeOrigin: performance.timeOrigin };
    });
    const ua = await page.evaluate(() => navigator.userAgent);
    const gl = await page.evaluate(() => {
      const c = document.createElement('canvas').getContext('webgl2');
      const e = c && c.getExtension('WEBGL_debug_renderer_info');
      return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : null;
    });
    let gcEvents = null;
    if (cfg.trace) {
      try {
        const tr = JSON.parse((await browser.stopTracing()).toString());
        const evs = tr.traceEvents ?? tr;
        const mark = evs.filter((e) => e.name === 'TimeStamp' && e.args?.data?.message === 'PROF_SYNC').pop();
        if (mark) {
          const off = mark.ts / 1000 - sync; // trace ms - page ms
          gcEvents = evs
            .filter((e) => (e.name === 'MinorGC' || e.name === 'MajorGC') && e.ph === 'X' && e.pid === mark.pid)
            .map((e) => ({ t: e.ts / 1000 - off, dur: e.dur / 1000, kind: e.name, before: e.args?.usedHeapSizeBefore, after: e.args?.usedHeapSizeAfter }));
        } else errors.push('trace: PROF_SYNC marker not found');
      } catch (e) {
        errors.push(`trace failed: ${String(e).slice(0, 120)}`);
      }
    }
    const res = analyse(raw, { ...cfg, url: url.replace(/^http:\/\/127\.0\.0.1:\d+/, ''), userAgent: ua, glRenderer: gl }, {
      readyWallMs,
      server: server ? { requests: server.stats.requests - reqs0, bytes: server.stats.bytes - bytes0 } : null,
      errors,
      gcEvents,
    });
    if (allocProfile) res.allocTop = summariseAlloc(allocProfile);
    if (cpuProf) res.cpuTop = summariseCpu(cpuProf);
    await context.close();
    return res;
  } finally {
    await browser.close();
  }
}

/** Self time per function from a CDP CPU profile (sampling), mapped through the build's source map; also by file. */
function summariseCpu(profile) {
  const maps = new Map();
  const mapOf = (url) => {
    const f = path.join(distDir, 'assets', path.basename(new URL(url).pathname) + '.map');
    if (!maps.has(url)) maps.set(url, fs.existsSync(f) ? new SourceMap(JSON.parse(fs.readFileSync(f, 'utf8'))) : null);
    return maps.get(url);
  };
  const where = (cf) => {
    try {
      const e = cf.url && mapOf(cf.url)?.findEntry(cf.lineNumber, cf.columnNumber);
      if (e && e.originalSource) return `${e.originalSource.replace(/^.*\/rally-web\//, '').replace(/^(\.\.\/)+/, '')}:${e.originalLine + 1}`;
    } catch {}
    return cf.url ? `${shortUrl(cf.url)}:${cf.lineNumber + 1}` : '(native)';
  };
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const deltas = profile.timeDeltas;
  let total = 0;
  profile.samples.forEach((id, i) => {
    const dt = (deltas[i] ?? 0) / 1000;
    const n = byId.get(id);
    const cf = n.callFrame;
    const key = `${cf.functionName || '(anonymous)'} ${where(cf)}`;
    self.set(key, (self.get(key) ?? 0) + dt);
    total += dt;
  });
  const byFile = new Map();
  for (const [k, v] of self) {
    const f = k.replace(/^.* /, '').replace(/:\d+$/, '');
    byFile.set(f, (byFile.get(f) ?? 0) + v);
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ site: k, ms: round(v, 0), pct: round((100 * v) / total, 1) }));
  return { totalMs: round(total, 0), topFunctions: top(self, 35), topFiles: top(byFile, 20) };
}

/** Flatten a CDP sampling heap profile into the top allocation sites (self bytes, includes objects already collected). */
function summariseAlloc(profile) {
  const by = new Map();
  const maps = new Map();
  const mapOf = (url) => {
    const f = path.join(distDir, 'assets', path.basename(new URL(url).pathname) + '.map');
    if (!maps.has(url)) maps.set(url, fs.existsSync(f) ? new SourceMap(JSON.parse(fs.readFileSync(f, 'utf8'))) : null);
    return maps.get(url);
  };
  const where = (cf) => {
    try {
      const e = cf.url && mapOf(cf.url)?.findEntry(cf.lineNumber, cf.columnNumber);
      if (e && e.originalSource) return `${e.originalSource.replace(/^.*\/rally-web\//, '').replace(/^(\.\.\/)+/, '')}:${e.originalLine + 1}`;
    } catch {}
    return `${shortUrl(cf.url || '')}:${cf.lineNumber + 1}`;
  };
  let total = 0;
  const walk = (n) => {
    const cf = n.callFrame;
    if (n.selfSize > 0) {
      const key = `${cf.functionName || '(anonymous)'} ${where(cf)}`;
      by.set(key, (by.get(key) ?? 0) + n.selfSize);
      total += n.selfSize;
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(profile.head);
  return { totalMB: round(total / 1e6), top: [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => ({ site: k, mb: round(v / 1e6, 2), pct: round((100 * v) / total, 1) })) };
}

// ------------------------------------------------------------------------------------------------ main

const args = parseArgs(process.argv.slice(2));
const list = (v, def) => (v === undefined || v === true ? def : String(v).split(',').map((s) => s.trim()).filter(Boolean));
const stages = list(args.stage, ['newzealand-2-f']);
const nets = list(args.net, ['none']);
const cpus = list(args.cpu, ['1']).map(Number);
for (const n of nets) if (!(n in NETS)) throw new Error(`unknown --net '${n}' (none|5g|slow)`);
const seconds = Number(args.seconds ?? 45);
const outDir = path.resolve(ROOT, typeof args.out === 'string' ? args.out : 'artifacts/frame-profile');
fs.mkdirSync(outDir, { recursive: true });
const sizeStr = typeof args.size === 'string' ? args.size : '960x540';
const size = sizeStr.split('x').map(Number);
const queries = {};
for (const qv of [].concat(args.query ?? []))
  if (qv !== true) { const s = String(qv); const eq = s.indexOf('='); if (eq > 0) queries[s.slice(0, eq)] = s.slice(eq + 1); }
const distDir = path.resolve(ROOT, typeof args.dist === 'string' ? args.dist : 'dist');

const trace = !!args.trace;
const browserArgs = [...CHROMIUM_ARGS, '--enable-precise-memory-info', '--autoplay-policy=no-user-gesture-required'];

let server = null;
let base;
if (typeof args.url === 'string') base = args.url;
else {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) throw new Error(`no ${distDir}/index.html: run npm run build first`);
  server = await startStatic(distDir, { gzip: !(args.gzip === '0' || args.gzip === 'false') });
  base = server.url;
}
console.log(`serving ${distDir} at ${base}`);

const summary = { schema: SCHEMA, runs: [] };
let failed = 0;
try {
  for (const stage of stages)
    for (const net of nets)
      for (const cpu of cpus) {
        const cfg = {
          stage, net, cpu, mobile: !!args.mobile, seconds, cache: args.cache === 'warm' ? 'warm' : 'cold', ai: Number(args.ai ?? 0),
          audio: !(args.audio === '0' || args.audio === 'false'), size, quality: typeof args.quality === 'string' ? args.quality : null, query: queries, headed: !!args.headed,
          readyTimeoutS: net === 'slow' ? 900 : 400, maxWallS: Number(args['max-wall'] ?? seconds * 8 + 120), trace, alloc: !!args.alloc, cpuprofile: !!args.cpuprofile, evalExpr: typeof args.eval === 'string' ? args.eval : null,
        };
        const label = `${typeof args.label === 'string' ? `${args.label}_` : ''}${stage}_${net}_cpu${cpu}${cfg.mobile ? '_mobile' : ''}${cfg.quality ? `_q${cfg.quality}` : ''}${cfg.ai ? `_ai${cfg.ai}` : ''}${cfg.cache === 'warm' ? '_warm' : ''}${cfg.alloc ? '_alloc' : ''}${cfg.cpuprofile ? '_cpuprof' : ''}${cfg.trace ? '_trace' : ''}`;
        process.stdout.write(`[run] ${label} ... `);
        const t0 = Date.now();
        try {
          const res = await runOne(browserArgs, base, cfg, server);
          res.label = label;
          fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(res, null, 1));
          const r = res.race;
          const row = {
            label, stage, net, cpu, mobile: cfg.mobile,
            readyMs: res.load.timeToReadyMs, readyKB: Math.round(res.load.bytesAtReady / 1024), readyReqs: res.load.requestsAtReady,
            frames: r?.frames ?? 0, fps: r?.fps, p50: r?.dtMs.p50, p95: r?.dtMs.p95, p99: r?.dtMs.p99, max: r?.dtMs.max,
            over2x: r?.framesOver2xMedian, jsP50: r?.jsMs.p50, jsMax: r?.jsMs.max, postReqs: res.postStartRequests?.count, postKB: res.postStartRequests?.totalKB,
            programsAdded: r?.rendererDelta.programs, texturesAdded: r?.rendererDelta.textures, geometriesAdded: r?.rendererDelta.geometries,
            gcDrops: r?.heapDrops.count, longtasks: r?.longtasks.count, classes: r?.classCounts, errors: res.errors.length + (res.notes?.length ?? 0),
          };
          summary.runs.push(row);
          console.log(`ok in ${((Date.now() - t0) / 1000).toFixed(0)} s: ready ${row.readyMs} ms, ${row.frames} frames, p50 ${row.p50} p99 ${row.p99} max ${row.max}, >2x ${row.over2x}, post-start reqs ${row.postReqs}`);
          if (res.errors.length) console.log(`   errors: ${res.errors.slice(0, 3).join(' | ')}`);
        } catch (e) {
          failed++;
          summary.runs.push({ label, stage, net, cpu, error: String(e).slice(0, 300) });
          console.log(`FAILED: ${e}`);
        }
      }
} finally {
  await server?.close();
}
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
const cols = ['label', 'readyMs', 'readyKB', 'readyReqs', 'frames', 'fps', 'p50', 'p95', 'p99', 'max', 'over2x', 'jsP50', 'jsMax', 'postReqs', 'postKB', 'programsAdded', 'texturesAdded', 'geometriesAdded', 'gcDrops', 'longtasks'];
const txt = [cols.join('\t'), ...summary.runs.map((r) => (r.error ? `${r.label}\tERROR ${r.error}` : cols.map((c) => r[c] ?? '').join('\t')))].join('\n');
fs.writeFileSync(path.join(outDir, 'summary.txt'), txt + '\n');
console.log('\n' + txt);
process.exit(failed ? 1 : 0);
