// scripts/clean-dist.mjs — prebuild: remove dist/ so no stale output survives
// (deleted sources, renamed views). No dependencies beyond node:fs.
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './main-module.mjs';

export function cleanDist(distDir) {
  rmSync(resolve(distDir), { recursive: true, force: true });
}

if (isMainModule(process.argv[1], import.meta.url)) {
  cleanDist(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
  console.log('clean-dist: removed dist/');
}
