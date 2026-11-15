// scripts/copy-assets.mjs — postbuild: copy non-TypeScript runtime assets into dist/.
// tsc only emits .js, but the server reads .sql schemas, .ejs views and
// src/public/** at runtime. Paths are preserved, so new district views
// (src/districts/**/views/*.ejs) are picked up with no changes here.
import { cpSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ASSET_EXTS = new Set(['.sql', '.ejs']);

function isAssetFile(src, file) {
  return relative(src, file).startsWith(`public${sep}`) || ASSET_EXTS.has(extname(file).toLowerCase());
}

// A directory is copied only if some file beneath it is an asset, so dist/
// gets no empty folders for code-only (or empty) source directories.
function containsAsset(src, dir) {
  return readdirSync(dir, { recursive: true }).some((rel) => {
    const p = join(dir, String(rel));
    return statSync(p).isFile() && isAssetFile(src, p);
  });
}

/** Copy every src/**\/*.sql, src/**\/*.ejs and src/public/** into distDir. */
export function copyAssets(srcDir, distDir) {
  const src = resolve(srcDir);
  const copied = [];
  cpSync(src, resolve(distDir), {
    recursive: true,
    filter: (from) => {
      if (from === src) return true;
      if (statSync(from).isDirectory()) return containsAsset(src, from);
      const keep = isAssetFile(src, from);
      if (keep) copied.push(relative(src, from));
      return keep;
    },
  });
  return copied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const copied = copyAssets(join(root, 'src'), join(root, 'dist'));
  console.log(`copy-assets: ${copied.length} file(s) copied into dist/`);
}
