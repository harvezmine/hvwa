import { describe, it, expect } from 'vitest';
import { defineChallenge, type Challenge } from '../src/core/registry.js';

describe('registry', () => {
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
});
