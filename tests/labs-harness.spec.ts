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
      expect(m.levels).toEqual(['acolyte', 'templar', 'inquisitor', 'divine']); // POC: 4 levels; Inquisitor is scored
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
      expect(existsSync(join(dir, 'app')), `${e.id}/app`).toBe(true);
      expect(existsSync(join(dir, 'seed')), `${e.id}/seed`).toBe(true);
      expect(existsSync(join(dir, 'README.md'))).toBe(true);
      expect(readFileSync(join(dir, 'VERSION'), 'utf8').trim()).toMatch(/^\d+\.\d+\.\d+$/);
      expect(readFileSync(join(dir, '.dockerignore'), 'utf8').replace(/\r\n/g, '\n')).toMatch(/(^|\n)solve($|\/|\n)/);
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
  // Everything the warden and portal act on: a stale registry must fail here, not at launch (e.g. a manifest port
  // changed to 9090 while the registry still pins 8080). Version and image are the registry's own additions.
  const OPERATIONAL = ['port', 'health', 'flag', 'tmpfs', 'resources', 'levels', 'hints', 'app', 'scenario',
    'themeId', 'difficulty', 'needsBot'] as const;

  it('parses, and once filled, each entry matches its lab dir manifest on every operational field', () => {
    const reg = parseRegistry(JSON.parse(readFileSync(join(process.cwd(), 'labs', 'registry.json'), 'utf8')));
    for (const entry of reg.labs) {
      const dir = join(LABS_DIR, `${entry.id}-${entry.slug}`);
      expect(existsSync(dir), `${entry.id}: no lab directory ${entry.id}-${entry.slug}`).toBe(true);
      const m = labManifestSchema.parse(readManifest(dir));
      for (const field of OPERATIONAL) {
        expect(entry[field], `${entry.id}: registry ${field} has drifted from ${entry.id}-${entry.slug}/lab.json`)
          .toEqual(m[field]);
      }
      expect(entry.image).toMatch(/^(?:.+@)?sha256:[a-f0-9]{64}$/);
    }
  });
});
