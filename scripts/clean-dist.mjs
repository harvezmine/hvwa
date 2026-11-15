// scripts/clean-dist.mjs — prebuild: remove dist/ so no stale output survives
// (deleted sources, renamed views). No dependencies beyond node:fs.
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function cleanDist(distDir) {
  rmSync(resolve(distDir), { recursive: true, force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cleanDist(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
  console.log('clean-dist: removed dist/');
}
