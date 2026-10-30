#!/usr/bin/env node
// tools/assets/run.mjs — `npm run assets -- [options]`: runs tools/assets/build.py (docs/ASSETS.md) with the
// project venv's python (.venv/bin/python or .venv/Scripts/python.exe) when present, else python3
// (RALLY_PYTHON overrides). Python runs isolated (-I); every option is passed through to build.py.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const venv = [path.join(ROOT, '.venv', 'bin', 'python'), path.join(ROOT, '.venv', 'Scripts', 'python.exe')].find((p) => fs.existsSync(p));
const python = process.env.RALLY_PYTHON || venv || (process.platform === 'win32' ? 'python' : 'python3');
const r = spawnSync(python, ['-I', path.join(ROOT, 'tools', 'assets', 'build.py'), ...process.argv.slice(2)], { stdio: 'inherit', cwd: ROOT });
if (r.error) {
  console.error(`assets: cannot run ${python}: ${r.error.message}\n  setup: uv venv .venv && uv pip install -r tools/assets/requirements.txt (docs/ASSETS.md)`);
  process.exit(1);
}
process.exit(r.status ?? 1);
