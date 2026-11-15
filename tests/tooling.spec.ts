import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  it('every file under src/ is valid UTF-8', () => {
    const bad: string[] = [];
    for (const rel of readdirSync(join(root, 'src'), { recursive: true }).map(String)) {
      const p = join(root, 'src', rel);
      if (!statSync(p).isFile()) continue;
      try { new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(p)); } catch { bad.push(rel); }
    }
    expect(bad).toEqual([]);
  });

  it('no control characters (other than tab, LF, CR) in src/, tests/ or scripts/', () => {
    const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
    const bad: string[] = [];
    for (const dir of ['src', 'tests', 'scripts']) {
      for (const rel of readdirSync(join(root, dir), { recursive: true }).map(String)) {
        const p = join(root, dir, rel);
        if (!statSync(p).isFile() || /\.(png|jpe?g|gif|ico|zip|woff2?)$/i.test(rel)) continue;
        if (CONTROL.test(readFileSync(p, 'latin1'))) bad.push(`${dir}/${rel}`);
      }
    }
    expect(bad).toEqual([]);
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
