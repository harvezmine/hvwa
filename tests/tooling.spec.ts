import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8'));

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

  it('npm run typecheck covers both tsconfigs', () => {
    expect(json('package.json').scripts.typecheck)
      .toBe('tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit');
  });
});
