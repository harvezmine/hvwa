// scripts/range-images.mjs — `npm run range:build` / `npm run range:push` (NOT part of `npm test`; needs Docker).
//   build: Dockerfile.range's range-portal and range-warden targets, tagged sigmajo/hvwa:range-<name>-<version>
//          (version: HVWA_RANGE_VERSION, else package.json's), and prints each local image id.
//   push:  pushes both tags and prints each pushed digest (repo@sha256:...), the values that pin them.
// PUSH IS MANUAL: only the controller runs it, after Task 29 passed, with `docker login` done by the owner.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './main-module.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RANGE_REPO = 'sigmajo/hvwa';
export const RANGE_TARGETS = Object.freeze(['range-portal', 'range-warden']);

/** HVWA_RANGE_VERSION (trimmed), else package.json's version; x.y.z only. */
export function rangeVersion(env, pkg) {
  const v = (env.HVWA_RANGE_VERSION ?? '').trim() || pkg.version;
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`the range version must be x.y.z (got "${v}")`);
  return v;
}

export function rangeTags(version) {
  return RANGE_TARGETS.map((target) => ({ target, tag: `${RANGE_REPO}:${target}-${version}` }));
}

function docker(args, capture = false) {
  const r = spawnSync('docker', args, { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')} failed (exit ${r.status})${capture ? `: ${(r.stderr ?? '').trim()}` : ''}`);
  return (r.stdout ?? '').trim();
}

export function main(argv, env) {
  const version = rangeVersion(env, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
  if (argv[0] === 'build') {
    for (const { target, tag } of rangeTags(version)) {
      docker(['build', '-f', 'Dockerfile.range', '--target', target, '-t', tag, '.']);
      console.log(`range:build ${tag} ${docker(['image', 'inspect', '--format', '{{.Id}}', tag], true)}`);
    }
    return 0;
  }
  if (argv[0] === 'push') {
    for (const { tag } of rangeTags(version)) {
      docker(['push', tag]);
      const digests = JSON.parse(docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', tag], true));
      console.log(`range:push ${tag} ${digests.filter((d) => d.startsWith(`${RANGE_REPO}@`)).join(' ')}`);
    }
    return 0;
  }
  console.error('usage: node scripts/range-images.mjs build|push');
  return 2;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(`range-images: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
