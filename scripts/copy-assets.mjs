// scripts/copy-assets.mjs — postbuild: copy every non-TypeScript file from
// src/ into dist/ (paths preserved). tsc only emits .js, but the server and
// the challenges read .sql, .ejs, src/public/** and fixtures of any type
// (.xml, .json, .zip, images, prompt files, ...) at runtime.
import { cpSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './main-module.mjs';

// TypeScript sources (including .d.ts and .spec.ts) are compiled or dropped,
// never copied; neither are vitest snapshots (__snapshots__/, *.snap).
const TS_SOURCE = /\.(c|m)?tsx?$/i;
const SNAPSHOT_FILE = /\.snap$/i;
const SNAPSHOT_DIR = '__snapshots__';

// View Source: a challenge's level files are shown to players verbatim, so
// src/districts/<district>/<challenge>/levels/<level>.ts ship in dist/ too
// (exactly that depth; .d.ts and .spec.ts never match).
const LEVEL_SOURCE = /^districts[\\/][^\\/]+[\\/][^\\/]+[\\/]levels[\\/][^\\/]+(?<!\.d|\.spec)\.ts$/;

/** `rel` is relative to src/, so only the source tree's own segments count. */
function isAssetFile(rel) {
  if (LEVEL_SOURCE.test(rel)) return true;
  if (TS_SOURCE.test(rel) || SNAPSHOT_FILE.test(rel)) return false;
  return !rel.split(/[\\/]/).includes(SNAPSHOT_DIR);
}

// A directory is copied only if some file beneath it is an asset, so dist/
// gets no empty folders for TypeScript-only, snapshot-only or empty dirs.
function containsAsset(src, dir) {
  return readdirSync(dir, { recursive: true }).some((r) => {
    const p = join(dir, String(r));
    return statSync(p).isFile() && isAssetFile(relative(src, p));
  });
}

/** Copy every non-TypeScript, non-snapshot file under srcDir into distDir; returns the copied relative paths. */
export function copyAssets(srcDir, distDir) {
  const src = resolve(srcDir);
  const copied = [];
  cpSync(src, resolve(distDir), {
    recursive: true,
    filter: (from) => {
      if (from === src) return true;
      const rel = relative(src, from);
      if (statSync(from).isDirectory()) return basename(from) !== SNAPSHOT_DIR && containsAsset(src, from);
      const keep = isAssetFile(rel);
      if (keep) copied.push(rel);
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
