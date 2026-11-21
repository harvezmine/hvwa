// scripts/lab-harness.mjs — shared, Docker-free helpers for the range lab harness (Plan B). Pure JS so the Vitest gate
// (tests/labs-harness.spec.ts) and the Docker runners (lab-test.mjs, lab-build.mjs) share one implementation. It reads
// lab.json as plain JSON; the authoritative schema check is the gate, which imports src/lab-registry.ts. Imports nothing
// from src/ and never shells out.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LABS_DIR = join(ROOT, 'labs');
/** The base image for the solve runner and the egress probe (always Node, even for Python labs: solves are HTTP clients). */
export const RUNNER_IMAGE = 'node:22.23.5-alpine3.24';
/** Container hardening ceilings, matching src/warden/template.ts (a manifest may only lower them). */
export const LIMITS = Object.freeze({ memoryMiB: 256, pids: 128, cpus: 0.5 });
const FLAG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Catalog lab directories: labs/<id>-<slug>, skipping labs/_* (the fixture) and non-directories. */
export function labDirs() {
  return readdirSync(LABS_DIR)
    .filter((name) => /^r\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    .map((name) => ({ name, path: join(LABS_DIR, name) }))
    .filter((d) => statSync(d.path).isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse a lab's lab.json (throws a readable error naming the file). */
export function readManifest(dir) {
  const file = join(dir, 'lab.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The lab's release version, from labs/<dir>/VERSION (default 1.0.0). The manifest itself carries no version. */
export function labVersion(dir) {
  try {
    return readFileSync(join(dir, 'VERSION'), 'utf8').trim() || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

/** spec §8.1: fail on any duplicate id, slug, app name, scenario (compared on .en) or themeId. */
export function uniquenessIssues(manifests) {
  const issues = [];
  const keyOf = { id: (m) => m.id, slug: (m) => m.slug, app: (m) => m.app, themeId: (m) => m.themeId, scenario: (m) => m.scenario?.en };
  for (const [field, fn] of Object.entries(keyOf)) {
    const seen = new Set();
    for (const m of manifests) {
      const value = fn(m);
      if (value === undefined) continue;
      if (seen.has(value)) issues.push(`duplicate ${field}: ${value}`);
      seen.add(value);
    }
  }
  return issues;
}

/** A fresh, valid-looking flag: HVWA{<26 chars of [a-z2-7]>} (RANGE_FLAG_RE). */
export function newFlag() {
  const bytes = randomBytes(26);
  let body = '';
  for (let i = 0; i < 26; i++) body += FLAG_ALPHABET[bytes[i] % 32];
  return `HVWA{${body}}`;
}

/**
 * The `docker run` arguments that mirror the range's hardening (src/warden/template.ts), for one lab container at one
 * level on the given internal network. The flag is NEVER an env var; `lab-test.mjs` writes it afterwards as the one-shot
 * file at HVWA_FLAG_FILE (a tiny `docker exec`, since a read-only rootfs blocks `docker cp`). `runtime` comes from
 * HVWA_LAB_TEST_RUNTIME (default runc).
 */
export function dockerRunArgs({ manifest, level, network, name, image, runtime }) {
  const memMiB = Math.min(manifest.resources?.memoryMiB ?? LIMITS.memoryMiB, LIMITS.memoryMiB);
  const pids = Math.min(manifest.resources?.pids ?? LIMITS.pids, LIMITS.pids);
  const cpus = Math.min(manifest.resources?.cpus ?? LIMITS.cpus, LIMITS.cpus);
  const tmpfs = (manifest.tmpfs ?? [{ path: '/tmp', sizeMiB: 64 }])
    .flatMap((t) => ['--tmpfs', `${t.path}:rw,noexec,nosuid,nodev,size=${t.sizeMiB}m`]);
  const env = [
    '-e', `HVWA_LEVEL=${level}`,
    '-e', `HVWA_PORT=${manifest.port}`,
    '-e', 'HVWA_INSTANCE_HOST=i-labtest.localhost',
    '-e', 'HOME=/tmp',
    '-e', 'HVWA_FLAG_FILE=/tmp/.hvwa-flag',
  ];
  return [
    'run', '-d', '--name', name, '--network', network,
    '--user', '10001:10001',
    '--read-only',
    ...tmpfs,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--pids-limit', String(pids),
    '--memory', `${memMiB}m`, '--memory-swap', `${memMiB}m`,
    '--cpus', String(cpus),
    '--restart', 'no',
    '--runtime', runtime,
    ...env,
    image,
  ];
}
