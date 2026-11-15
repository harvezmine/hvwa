import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyAssets, main } from '../scripts/copy-assets.mjs';
import { cleanDist } from '../scripts/clean-dist.mjs';
import { isMainModule } from '../scripts/main-module.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'hvwa-assets-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, 'src', rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return { src: join(root, 'src'), dist: join(root, 'dist') };
}

describe('copyAssets', () => {
  it('copies every non-TypeScript file under src/, preserving paths', () => {
    const { src, dist } = tree({
      'db/schema.sql': 'CREATE TABLE t(x);',
      'core/views/layout.ejs': '<%- body %>',
      'public/app.css': 'body{}',
      'public/img/logo.svg': '<svg/>',
      // challenge fixtures of any type must reach dist/
      'districts/scriptorium/sc-14-xxe-docx/fixtures/payload.xml': '<x/>',
      'districts/archive-api/ar-01/fixtures/schema.json': '{}',
      'districts/scriptorium/sc-10-zip-slip/fixtures/evil.zip': 'PK',
      'districts/oracle/or-01/prompts/system.txt': 'You are...',
      'districts/oracle/or-01/prompts/persona.md': '# persona',
      'districts/forge/fo-01/fixtures/image.png': 'png',
    });
    const copied = copyAssets(src, dist);
    expect(copied).toHaveLength(10);
    expect(readFileSync(join(dist, 'db/schema.sql'), 'utf8')).toBe('CREATE TABLE t(x);');
    for (const rel of [
      'core/views/layout.ejs', 'public/img/logo.svg',
      'districts/scriptorium/sc-14-xxe-docx/fixtures/payload.xml',
      'districts/archive-api/ar-01/fixtures/schema.json',
      'districts/scriptorium/sc-10-zip-slip/fixtures/evil.zip',
      'districts/oracle/or-01/prompts/system.txt',
      'districts/oracle/or-01/prompts/persona.md',
      'districts/forge/fo-01/fixtures/image.png',
    ]) expect(existsSync(join(dist, rel)), rel).toBe(true);
  });

  it('never copies TypeScript sources: .ts, .d.ts, .spec.ts', () => {
    const { src, dist } = tree({
      'db/schema.sql': 'x',
      'core/registry.ts': 'export {}',
      'types/ejs.d.ts': 'declare module "ejs";',
      'districts/gatekeeper/gk-01/gk-01.spec.ts': 'test',
      'districts/gatekeeper/gk-01/views/login.ejs': '<form></form>',
    });
    copyAssets(src, dist);
    expect(existsSync(join(dist, 'core/registry.ts'))).toBe(false);
    expect(existsSync(join(dist, 'types/ejs.d.ts'))).toBe(false);
    expect(existsSync(join(dist, 'districts/gatekeeper/gk-01/gk-01.spec.ts'))).toBe(false);
    expect(existsSync(join(dist, 'districts/gatekeeper/gk-01/views/login.ejs'))).toBe(true);
  });

  it('excludes vitest snapshots: __snapshots__/ directories and *.snap files', () => {
    const { src, dist } = tree({
      'db/schema.sql': 'x',
      'districts/gatekeeper/gk-01/__snapshots__/gk-01.spec.ts.snap': 'exports[...]',
      'districts/gatekeeper/gk-01/__snapshots__/notes.txt': 'not an asset either',
      'districts/gatekeeper/gk-01/inline.snap': 'x',
      'districts/gatekeeper/gk-01/views/login.ejs': '<form></form>',
    });
    const copied = copyAssets(src, dist);
    expect(copied.map((p: string) => p.split(sep).join('/')).sort())
      .toEqual(['db/schema.sql', 'districts/gatekeeper/gk-01/views/login.ejs']);
    expect(existsSync(join(dist, 'districts/gatekeeper/gk-01/__snapshots__'))).toBe(false);
    expect(existsSync(join(dist, 'districts/gatekeeper/gk-01/inline.snap'))).toBe(false);
  });

  it('creates no empty directories for TypeScript-only or empty source folders', () => {
    const { src, dist } = tree({
      'db/schema.sql': 'x',
      'core/registry.ts': 'export {}',
      'core/nested/deep.ts': 'export {}',
      'types/ejs.d.ts': 'declare module "ejs";',
    });
    mkdirSync(join(src, 'public', 'empty'), { recursive: true });
    copyAssets(src, dist);
    expect(existsSync(join(dist, 'db/schema.sql'))).toBe(true);
    for (const dir of ['core', 'types', 'public']) {
      expect(existsSync(join(dist, dir)), `dist/${dir} should not exist`).toBe(false);
    }
  });
});

describe('copy-assets main()', () => {
  it('returns 0 and reports the count when files were copied', () => {
    const { src, dist } = tree({ 'db/schema.sql': 'x', 'a/b.json': '{}' });
    const logs: string[] = [];
    expect(main({ srcDir: src, distDir: dist, log: (m: string) => logs.push(m) })).toBe(0);
    expect(logs.join('\n')).toMatch(/2 file\(s\) copied/);
  });

  it('returns 1 when nothing was copied (misconfigured build)', () => {
    const { src, dist } = tree({ 'core/only.ts': 'export {}' });
    const errors: string[] = [];
    expect(main({ srcDir: src, distDir: dist, log: () => {}, error: (m: string) => errors.push(m) })).toBe(1);
    expect(errors.join('\n')).toMatch(/no files copied/i);
  });
});

describe('isMainModule (realpath-based guard)', () => {
  const script = join(here, '..', 'scripts', 'copy-assets.mjs');
  const url = pathToFileURL(script).href;

  it('matches the script itself, also through a non-normalised path', () => {
    expect(isMainModule(script, url)).toBe(true);
    expect(isMainModule(join(here, '..', 'scripts', '..', 'scripts', 'copy-assets.mjs'), url)).toBe(true);
  });

  it('does not match another file, a missing file, or no argv[1]', () => {
    expect(isMainModule(join(here, '..', 'scripts', 'clean-dist.mjs'), url)).toBe(false);
    expect(isMainModule(join(here, 'nope.mjs'), url)).toBe(false);
    expect(isMainModule(undefined, url)).toBe(false);
  });
});

describe('cleanDist', () => {
  it('removes the output directory and tolerates it being absent', () => {
    const { dist } = tree({ 'db/schema.sql': 'x' });
    mkdirSync(join(dist, 'stale', 'old'), { recursive: true });
    writeFileSync(join(dist, 'stale', 'old', 'gone.js'), '');
    cleanDist(dist);
    expect(existsSync(dist)).toBe(false);
    expect(() => cleanDist(dist)).not.toThrow();
  });
});

describe('build scripts', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

  it('prebuild cleans, postbuild copies', () => {
    expect(pkg.scripts.prebuild).toBe('node scripts/clean-dist.mjs');
    expect(pkg.scripts.postbuild).toBe('node scripts/copy-assets.mjs');
  });

  it('verify:dist exists and is not part of npm test', () => {
    expect(pkg.scripts['verify:dist']).toBe('node scripts/verify-dist.mjs');
    expect(pkg.scripts.test).not.toMatch(/verify/);
  });
});
