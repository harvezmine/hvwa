// The range images (spec range §12): Dockerfile.range builds `range-portal` and `range-warden` from one compile; the tags
// are sigmajo/hvwa:range-<name>-<version>; range:build / range:push / range:verify are scripts outside `npm test`.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RANGE_REPO, RANGE_TARGETS, rangeTags, rangeVersion } from '../scripts/range-images.mjs';

const root = process.cwd();
const read = (f: string) => readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n');
const stage = (df: string, name: string) => {
  const at = df.indexOf(` AS ${name}\n`);
  if (at < 0) throw new Error(`no stage ${name}`);
  const next = df.indexOf('\nFROM ', at);
  return df.slice(at, next < 0 ? undefined : next).split('\n');
};

describe('scripts/range-images.mjs', () => {
  it('tags sigmajo/hvwa:range-portal-<version> and range-warden-<version>', () => {
    expect(RANGE_REPO).toBe('sigmajo/hvwa');
    expect(RANGE_TARGETS).toEqual(['range-portal', 'range-warden']);
    expect(rangeTags('0.1.0')).toEqual([
      { target: 'range-portal', tag: 'sigmajo/hvwa:range-portal-0.1.0' },
      { target: 'range-warden', tag: 'sigmajo/hvwa:range-warden-0.1.0' },
    ]);
  });

  it('the version is HVWA_RANGE_VERSION, else package.json\'s; it must be x.y.z', () => {
    expect(rangeVersion({}, { version: '0.1.0' })).toBe('0.1.0');
    expect(rangeVersion({ HVWA_RANGE_VERSION: ' 1.2.3 ' }, { version: '0.1.0' })).toBe('1.2.3');
    expect(() => rangeVersion({ HVWA_RANGE_VERSION: 'latest' }, { version: '0.1.0' })).toThrow(/x\.y\.z/);
  });

  it('package.json has range:build, range:push and range:verify; none of them is part of npm test', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts['range:build']).toBe('node scripts/range-images.mjs build');
    expect(scripts['range:push']).toBe('node scripts/range-images.mjs push');
    expect(scripts['range:verify']).toBe('node scripts/range-verify.mjs');
    expect(scripts.test).toBe('vitest run');
  });
});

describe('Dockerfile.range', () => {
  const df = read('Dockerfile.range');

  it('one compile, a production-only base without package managers, then two non-root targets', () => {
    expect(df).toContain('ARG NODE_IMAGE=node:22.23.5-alpine3.24\n');
    expect(df).toContain('RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \\\n');
    expect(df).toContain('/usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack');
    const warden = stage(df, 'range-warden');
    expect(warden).toEqual(expect.arrayContaining(['USER node', 'CMD ["node", "dist/warden/main.js"]', 'EXPOSE 8080']));
    const portal = stage(df, 'range-portal');
    expect(portal).toEqual(expect.arrayContaining(['USER node', 'CMD ["node", "dist/server.js"]', 'EXPOSE 1337',
      'RUN mkdir -p /data && chown node:node /data']));
    expect(portal.join('\n')).toContain('HVWA_MODE=portal');
    expect(portal.join('\n')).toContain('HVWA_ALLOW_REMOTE=1');
    expect(df).not.toMatch(/COPY\s+labs/);
    expect(df).not.toMatch(/docker\.sock/);
  });

  it('the build context leaves out the lab packages and the range Dockerfile itself', () => {
    const ignore = read('.dockerignore').split('\n');
    expect(ignore).toEqual(expect.arrayContaining(['labs', 'Dockerfile.range']));
  });
});
