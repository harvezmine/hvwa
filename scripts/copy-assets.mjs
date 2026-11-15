// scripts/copy-assets.mjs — postbuild: copy non-TypeScript runtime assets into dist/.
// tsc only emits .js, but the server reads .sql schemas, .ejs views and
// src/public/** at runtime. Paths are preserved, so new district views
// (src/districts/**/views/*.ejs) are picked up with no changes here.
import { cpSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ASSET_EXTS = new Set(['.sql', '.ejs']);

/** Copy every src/**\/*.sql, src/**\/*.ejs and src/public/** into distDir. */
export function copyAssets(srcDir, distDir) {
  const src = resolve(srcDir);
  const copied = [];
  cpSync(src, resolve(distDir), {
    recursive: true,
    filter: (from) => {
      const rel = relative(src, from);
      if (rel === '' || statSync(from).isDirectory()) return true;
      const inPublic = rel.startsWith(`public${sep}`);
      const keep = inPublic || ASSET_EXTS.has(extname(from).toLowerCase());
      if (keep) copied.push(rel);
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
