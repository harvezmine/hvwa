// The portal lists challenges by id within each district, whatever order they were registered in.
// The challenge imports come FIRST and in reverse id order, so registration order is reversed.
import '../districts/gatekeeper/gk-18-role-cookie/challenge.js';
import '../districts/gatekeeper/gk-13-hidden-admin-function/challenge.js';
import '../districts/gatekeeper/gk-12-idor-profile/challenge.js';
import { describe, it, expect } from 'vitest';
import { freshSession } from '../../tests/helpers.js';
import { allChallenges } from '../core/registry.js';

describe('portal order', () => {
  it('registration order is not id order here (the fixture of this test)', () => {
    const ids = allChallenges().map((c) => c.id);
    expect(ids.indexOf('GK-18')).toBeLessThan(ids.indexOf('GK-12'));
  });

  it('the district list is sorted by challenge id, numerically', async () => {
    const { agent } = await freshSession();
    const res = await agent.get('/');
    const listed = [...res.text.matchAll(/<span class="challenge-id">(GK-\d+)<\/span>/g)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThanOrEqual(3);
    expect(listed).toEqual([...listed].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    expect(listed.indexOf('GK-12')).toBeLessThan(listed.indexOf('GK-18'));
  });
});
