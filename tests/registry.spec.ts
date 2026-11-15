import { describe, it, expect, beforeAll } from 'vitest';
import { defineChallenge, type Challenge } from '../src/core/registry.js';
import { issueFlag, setFlagSecret } from '../src/core/flags.js';
import { openDb } from '../src/db/index.js';

describe('registry', () => {
  beforeAll(() => setFlagSecret('test-secret'));

  it('defineChallenge enforces required metadata and defaults points', () => {
    const c: Challenge = defineChallenge({
      id: 'GK-01', district: 'gatekeeper', slug: 'sqli-login',
      title: { id: 'Login SQLi', en: 'Login SQLi' },
      summary: { id: 'x', en: 'x' }, maps: ['A05:2025'],
      levels: ['acolyte', 'divine'], hints: [], check: () => true, mount: () => {},
    });
    expect(c.id).toBe('GK-01');
    expect(c.points).toBeGreaterThan(0);
  });

  it('defaults check() to verifying the level-bound flag', async () => {
    const c = defineChallenge({
      id: 'GK-99', district: 'gatekeeper', slug: 'x', title: { id: 'x', en: 'x' },
      summary: { id: 'x', en: 'x' }, maps: [], levels: ['acolyte', 'templar'], hints: [], mount: () => {},
    });
    const db = openDb(':memory:');
    const flag = issueFlag('GK-99', 's1', 'templar');
    expect(await c.check({ sessionId: 's1', level: 'templar', submission: flag, db })).toBe(true);
    expect(await c.check({ sessionId: 's1', level: 'acolyte', submission: flag, db })).toBe(false);
  });
});
