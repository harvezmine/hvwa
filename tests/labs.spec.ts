// Smoke test over the real district list: every registered challenge's lab
// answers GET at every implemented level, inside the lab bar.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import '../src/districts/index.js'; // registers every challenge
import { allChallenges } from '../src/core/registry.js';
import { challengePath } from '../src/core/mount.js';
import { createApp } from '../src/app.js';

const challenges = allChallenges();
const cases = challenges.flatMap((c) =>
  c.levels.map((level) => ({ id: c.id, level, url: `${challengePath(c)}?level=${level}` })));

describe('every lab, every level', () => {
  it('discovers at least one registered challenge', () => {
    expect(challenges.length).toBeGreaterThan(0);
  });

  const app = createApp();
  it.each(cases)('$id lab at $level: 200 with the lab bar ($url)', async ({ id, level, url }) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-testid="lab-bar"');
    expect(res.text).toMatch(new RegExp(`data-testid="lab-level"[^>]*data-level="${level}"`));
    expect(res.text).toContain(`<a class="lab-bar-back" href="/c/${id}">`);
  });
});
