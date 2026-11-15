// scripts/copy-assets.mjs — postbuild: copy every non-TypeScript file from
// src/ into dist/ (paths preserved). tsc only emits .js, but the server and
// the challenges read .sql, .ejs, src/public/** and fixtures of any type
// (.xml, .json, .zip, images, prompt files, ...) at runtime.
import { cpSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './main-module.mjs';

// TypeScript sources (including .d.ts and .spec.ts) are compiled or dropped,
// never copied.
const TS_SOURCE = /\.(c|m)?tsx?$/i;

function isAssetFile(file) {
  return !TS_SOURCE.test(file);
}

// A directory is copied only if some file beneath it is an asset, so dist/
// gets no empty folders for TypeScript-only (or empty) source directories.
function containsAsset(dir) {
  return readdirSync(dir, { recursive: true }).some((rel) => {
    const p = join(dir, String(rel));
    return statSync(p).isFile() && isAssetFile(p);
  });
}

/** Copy every non-TypeScript file under srcDir into distDir; returns the copied relative paths. */
export function copyAssets(srcDir, distDir) {
  const src = resolve(srcDir);
  const copied = [];
  cpSync(src, resolve(distDir), {
    recursive: true,
    filter: (from) => {
      if (from === src) return true;
      if (statSync(from).isDirectory()) return containsAsset(from);
      const keep = isAssetFile(from);
      if (keep) copied.push(from.slice(src.length + 1));
      return keep;
    },
  });
  return copied;
}

/** CLI entry: returns the process exit code (1 if nothing was copied). */
export function main({ srcDir, distDir, log = console.log, error = console.error }) {
  const copied = copyAssets(srcDir, distDir);
  if (copied.length === 0) {
    error(`copy-assets: no files copied from ${srcDir} — the build would be missing its runtime assets`);
    return 1;
  }
  log(`copy-assets: ${copied.length} file(s) copied into ${distDir}`);
  return 0;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  process.exitCode = main({ srcDir: join(root, 'src'), distDir: join(root, 'dist') });
}
