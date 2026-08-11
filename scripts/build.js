// scripts/build.js — "npm run build" for the backend.
// The backend is plain Node ESM (no bundler / transpile step), so the build
// step is a full syntax check of every source file. Fails (exit 1) if any
// file does not parse, mirroring what a real compile would catch.
import { readdirSync, statSync } from 'fs';
import { join, extname, sep } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const SKIP = new Set(['node_modules', '.git', 'uploads', 'exports', 'dist', '.vercel']);

const files = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
    } else if (extname(full) === '.js') {
      files.push(full);
    }
  }
}

walk(root);

let failed = 0;
for (const file of files) {
  const rel = file.replace(root + sep, '');
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    failed += 1;
    console.error(`\n✗ ${rel}`);
    if (res.stderr) {
      console.error(
        res.stderr
          .split('\n')
          .filter(Boolean)
          .slice(0, 4)
          .join('\n')
      );
    }
  }
}

if (failed > 0) {
  console.error(`\nBuild failed: ${failed}/${files.length} file(s) have syntax errors.`);
  process.exit(1);
}

console.log(`Build OK — ${files.length} file(s) syntax-checked.`);
