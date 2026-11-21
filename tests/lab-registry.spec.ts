// The lab registry (src/lab-registry.ts, spec range §8.4/§12): one schema for lab.json and labs/registry.json. It is the
// warden's image allowlist (digest-pinned images only) and the portal's catalog, so anything outside it is refused.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIFFICULTY_POINTS, labManifestSchema, labPoints, loadRegistry, parseRegistry } from '../src/lab-registry.js';
import { labEntry, testRegistry } from './support/range.js';

const reg = (...labs: Record<string, unknown>[]) => ({ schema: 1, labs });

describe('parseRegistry', () => {
  it('parses an entry and fills the defaults: no lower limits, one 64 MiB /tmp tmpfs, no hints', () => {
    const r = parseRegistry(reg(labEntry('r01', 'clinic', { hints: undefined })));
    const lab = r.get('r01');
    expect(lab).toMatchObject({ id: 'r01', slug: 'clinic', resources: {}, tmpfs: [{ path: '/tmp', sizeMiB: 64 }], hints: [] });
    expect(r.labs).toHaveLength(1);
    expect(r.get('r99')).toBeUndefined();
    expect(Object.isFrozen(r.labs)).toBe(true);
  });

  it('accepts only digest-pinned images: repo[:tag]@sha256:<64 hex> or a local sha256:<64 hex> image id', () => {
    const digest = 'c'.repeat(64);
    for (const image of [`sigmajo/hvwa:lab-x-1.0.0@sha256:${digest}`, `hvwa-lab/r01@sha256:${digest}`, `sha256:${digest}`]) {
      expect(() => parseRegistry(reg(labEntry('r01', 'clinic', { image }))), image).not.toThrow();
    }
    for (const image of ['sigmajo/hvwa:lab-x-1.0.0', 'sigmajo/hvwa:latest', `sha256:${'C'.repeat(64)}`, `sha256:${digest.slice(1)}`,
      `docker.io/../x@sha256:${digest}`, '']) {
      expect(() => parseRegistry(reg(labEntry('r01', 'clinic', { image }))), image).toThrow(/image/);
    }
  });

  it('refuses keys it does not know: nothing in a manifest can widen the container (privileged, mounts, ports)', () => {
    for (const extra of [{ privileged: true }, { hostConfig: {} }, { mounts: ['/:/host'] }, { ports: ['80:80'] }]) {
      expect(() => parseRegistry(reg(labEntry('r01', 'clinic', extra)))).toThrow(/Unrecognized key/);
    }
    expect(() => parseRegistry(reg(labEntry('r01', 'clinic', { resources: { memoryMiB: 128, privileged: true } })))).toThrow();
  });

  it('a manifest may only lower the limits: memory <= 256 MiB, pids <= 128, cpus <= 0.5, tmpfs <= 64 MiB in total', () => {
    expect(() => parseRegistry(reg(labEntry('r01', 'clinic', { resources: { memoryMiB: 128, pids: 64, cpus: 0.25 } })))).not.toThrow();
    for (const resources of [{ memoryMiB: 512 }, { pids: 256 }, { cpus: 1 }]) {
      expect(() => parseRegistry(reg(labEntry('r01', 'clinic', { resources }))), JSON.stringify(resources)).toThrow();
    }
    expect(() => parseRegistry(reg(labEntry('r01', 'clinic', { tmpfs: [{ path: '/tmp', sizeMiB: 40 }, { path: '/var/run/app', sizeMiB: 30 }] })))).toThrow(/64 MiB/);
    for (const path of ['tmp', '/tmp/../etc', '/tmp//x', '/tmp x']) {
      expect(() => parseRegistry(reg(labEntry('r01', 'clinic', { tmpfs: [{ path, sizeMiB: 8 }] }))), path).toThrow();
    }
  });

  it('checks ids, levels, port, health, flag placement; refuses duplicate ids and slugs', () => {
    for (const over of [{ id: 'R01' }, { id: 'r1' }, { levels: ['divine'] }, { levels: ['acolyte', 'acolyte'] }, { port: 80 },
      { health: 'healthz' }, { flag: { placement: 'somewhere' } }, { difficulty: 'insane' }, { version: '1.0' }]) {
      expect(() => parseRegistry(reg(labEntry('r01', 'clinic', over))), JSON.stringify(over)).toThrow();
    }
    for (const placement of ['file:/tmp/hvwa/flag.txt', 'db:patients.notes', 'env-only', 'custom']) {
      expect(() => parseRegistry(reg(labEntry('r01', 'clinic', { flag: { placement } }))), placement).not.toThrow();
    }
    expect(() => parseRegistry(reg(labEntry('r01', 'clinic'), labEntry('r01', 'other')))).toThrow(/duplicate id/);
    expect(() => parseRegistry(reg(labEntry('r01', 'clinic'), labEntry('r02', 'clinic')))).toThrow(/duplicate slug/);
  });

  it('the compact POC shape: three levels (Acolyte, Templar, Divine) and no victim bot', () => {
    const r = parseRegistry(reg(labEntry('r01', 'clinic', { levels: ['acolyte', 'templar', 'divine'], needsBot: false })));
    expect(r.get('r01')).toMatchObject({ levels: ['acolyte', 'templar', 'divine'], needsBot: false });
  });

  it('lab.json is the same schema without version and image', () => {
    const { version, image, ...manifest } = labEntry('r03', 'bank');
    expect(version).toBe('1.0.0');
    expect(image).toMatch(/@sha256:/);
    expect(labManifestSchema.safeParse(manifest).success).toBe(true);
    expect(labManifestSchema.safeParse({ ...manifest, image }).success).toBe(false);
  });

  it('the test kit registry parses (two labs, r02 on a local image id)', () => {
    const r = testRegistry();
    expect(r.labs.map((l) => [l.id, l.difficulty, l.levels.length])).toEqual([['r01', 'easy', 4], ['r02', 'medium', 2]]);
  });
});

describe('labs/registry.json', () => {
  it('is valid (Plan B fills it via labs:build; empty before the first build)', () => {
    const path = join(process.cwd(), 'labs', 'registry.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw.schema).toBe(1);
    expect(loadRegistry(path).labs.map((l) => l.id)).toEqual(raw.labs.map((l: { id: string }) => l.id));
  });

  it('loadRegistry names the file in its errors', () => {
    expect(() => loadRegistry(join(process.cwd(), 'labs', 'no-such-registry.json'))).toThrow(/no-such-registry\.json/);
  });
});

describe('labPoints', () => {
  it('base points by rating (100/200/300/400) times the level multiplier; Divine scores 0', () => {
    expect(DIFFICULTY_POINTS).toEqual({ easy: 100, medium: 200, hard: 300, expert: 400 });
    expect(['acolyte', 'templar', 'inquisitor', 'divine'].map((l) => labPoints({ difficulty: 'medium' }, l as 'acolyte')))
      .toEqual([200, 300, 400, 0]);
  });
});
