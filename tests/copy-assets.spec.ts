import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs build script without type declarations
import { copyAssets } from '../scripts/copy-assets.mjs';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'hvwa-assets-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, 'src', rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return { src: join(root, 'src'), dist: join(root, 'dist') };
}

describe('copy-assets', () => {
  it('copies .sql, .ejs and public/** into dist preserving paths, and nothing else', () => {
    const { src, dist } = tree({
      'db/schema.sql': 'CREATE TABLE t(x);',
      'portal/views/layout.ejs': '<%- body %>',
      // a district added later must be picked up without touching the script
      'districts/gatekeeper/gk-01-sqli-login/views/login.ejs': '<form></form>',
      'public/app.css': 'body{}',
      'public/img/logo.svg': '<svg/>',
      'core/registry.ts': 'export {}',
      'types/ejs.d.ts': 'declare module "ejs";',
      'districts/gatekeeper/gk-01-sqli-login/gk-01.spec.ts': 'test',
    });
    copyAssets(src, dist);
    expect(readFileSync(join(dist, 'db/schema.sql'), 'utf8')).toBe('CREATE TABLE t(x);');
    expect(existsSync(join(dist, 'portal/views/layout.ejs'))).toBe(true);
    expect(existsSync(join(dist, 'districts/gatekeeper/gk-01-sqli-login/views/login.ejs'))).toBe(true);
    expect(existsSync(join(dist, 'public/app.css'))).toBe(true);
    expect(existsSync(join(dist, 'public/img/logo.svg'))).toBe(true);
    expect(existsSync(join(dist, 'core/registry.ts'))).toBe(false);
    expect(existsSync(join(dist, 'types/ejs.d.ts'))).toBe(false);
    expect(existsSync(join(dist, 'districts/gatekeeper/gk-01-sqli-login/gk-01.spec.ts'))).toBe(false);
  });

  it('is wired as the postbuild step', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    expect(pkg.scripts.postbuild).toBe('node scripts/copy-assets.mjs');
  });
});
