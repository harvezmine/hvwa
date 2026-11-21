// scripts/lab-build.mjs — `npm run labs:build [-- --lab r0N]`. Builds sigmajo/hvwa:lab-<slug>-<version> for every catalog
// lab and rewrites labs/registry.json with each entry = lab.json + version (labs/<dir>/VERSION) + image (the LOCAL image
// id, sha256:<64 hex>). NEVER pushes (Plan E pushes and re-pins by repo digest). NOT part of `npm test` (needs Docker).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule } from './main-module.mjs';
import { labDirs, readManifest, labVersion, LABS_DIR } from './lab-harness.mjs';

const REGISTRY = join(LABS_DIR, 'registry.json');

function docker(args, capture = false) {
  const r = spawnSync('docker', args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} failed (exit ${r.status})${capture ? `: ${(r.stderr ?? '').trim()}` : ''}`);
  return (r.stdout ?? '').trim();
}

export function main(argv) {
  const only = (() => { const i = argv.indexOf('--lab'); return i >= 0 ? argv[i + 1] : undefined; })();
  const dirs = labDirs().filter((d) => !only || d.name.startsWith(`${only}-`));
  if (dirs.length === 0) throw new Error(only ? `no lab ${only}` : 'no labs under labs/');

  const existing = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const byId = new Map((existing.labs ?? []).map((l) => [l.id, l]));

  for (const dir of dirs) {
    const manifest = readManifest(dir.path);
    const version = labVersion(dir.path);
    const tag = `sigmajo/hvwa:lab-${manifest.slug}-${version}`;
    docker(['build', '-t', tag, dir.path]);
    const id = docker(['image', 'inspect', '--format', '{{.Id}}', tag], true); // sha256:<64 hex>
    byId.set(manifest.id, { ...manifest, version, image: id });
    console.log(`labs:build ${tag} ${id}`);
  }

  const labs = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(REGISTRY, `${JSON.stringify({ schema: 1, labs }, null, 2)}\n`, 'utf8');
  console.log(`labs:build wrote ${REGISTRY} (${labs.length} lab(s))`);
  return 0;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (err) { console.error(`labs:build: ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
}
