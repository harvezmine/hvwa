import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hygieneProblems } from './helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8'));

describe('architecture', () => {
  it('core/ never imports from portal/ or districts/ (the engine is challenge-agnostic)', () => {
    const coreDir = join(root, 'src', 'core');
    const offenders = readdirSync(coreDir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /from\s+['"]\.\.\/(portal|districts)\//.test(readFileSync(join(coreDir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the shared layout lives in core; the portal owns its own views dir', async () => {
    expect(existsSync(join(root, 'src', 'core', 'views', 'layout.ejs'))).toBe(true);
    expect(existsSync(join(root, 'src', 'portal', 'views', 'layout.ejs'))).toBe(false);
    const portal = await import('../src/portal/index.js');
    // Compare relatively: an absolute compare breaks when the cwd's drive
    // letter case ('c:' vs 'C:') differs between modules on Windows.
    expect(relative(root, portal.portalViewsDir)).toBe(join('src', 'portal', 'views'));
  });
});

describe('source hygiene', () => {
  it('text sources under src/, tests/ and scripts/ are valid UTF-8 with no control characters', () => {
    const { badUtf8, control } = hygieneProblems(root, ['src', 'tests', 'scripts']);
    expect(badUtf8).toEqual([]);
    expect(control).toEqual([]);
  });

  it('the hygiene scan skips non-text extensions and fixtures/ but still flags text sources', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hvwa-hyg-'));
    try {
      mkdirSync(join(tmp, 'src', 'lab', 'fixtures'), { recursive: true });
      writeFileSync(join(tmp, 'src', 'lab', 'blob.bin'), Buffer.from([0, 1, 2, 0xff]));
      writeFileSync(join(tmp, 'src', 'lab', 'fixtures', 'x.txt'), Buffer.from([0, 0xfe]));
      writeFileSync(join(tmp, 'src', 'lab', 'fixtures', 'y.ts'), Buffer.from([0, 0xfe]));
      expect(hygieneProblems(tmp, ['src'])).toEqual({ badUtf8: [], control: [] });
      writeFileSync(join(tmp, 'src', 'lab', 'bad.ts'), Buffer.from([0x61, 0, 0x62]));
      writeFileSync(join(tmp, 'src', 'lab', 'bad2.ejs'), Buffer.from([0x61, 0x97]));
      const r = hygieneProblems(tmp, ['src']);
      expect(r.control.map((x) => x.split(sep).join('/'))).toEqual(['src/lab/bad.ts']);
      expect(r.badUtf8.map((x) => x.split(sep).join('/'))).toEqual(['src/lab/bad2.ejs']);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });


  it('server.ts verifies challenge files before creating the app', () => {
    const src = readFileSync(join(root, 'src', 'server.ts'), 'utf8');
    const v = src.indexOf('assertChallengeFiles(c)');
    expect(v).toBeGreaterThan(-1);
    expect(v).toBeLessThan(src.indexOf('createApp({'));
  });

  it('server.ts imports the district list before the app', () => {
    const src = readFileSync(join(root, 'src', 'server.ts'), 'utf8');
    const d = src.indexOf('./districts/index.js');
    const a = src.indexOf('./app.js');
    expect(d).toBeGreaterThan(-1);
    expect(a).toBeGreaterThan(-1);
    expect(d).toBeLessThan(a);
  });
});

describe('tooling', () => {
  it('the build tsconfig excludes spec files (district specs live under src/)', () => {
    expect(json('tsconfig.json').exclude).toContain('src/**/*.spec.ts');
  });

  it('the test tsconfig type-checks src (including specs) and tests', () => {
    const t = json('tsconfig.test.json');
    expect(t.include).toEqual(expect.arrayContaining(['src', 'tests']));
    expect(t.exclude ?? []).not.toContain('src/**/*.spec.ts');
    expect(t.compilerOptions.noEmit).toBe(true);
  });

  it('requires Node >= 22.16 (node:sqlite isTransaction + open timeout)', () => {
    expect(json('package.json').engines.node).toBe('>=22.16');
  });

  it('npm run typecheck covers both tsconfigs', () => {
    expect(json('package.json').scripts.typecheck)
      .toBe('tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit');
  });
});
