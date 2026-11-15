import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { register, defineChallenge } from '../src/core/registry.js';

register(defineChallenge({
  id: 'PT-01', district: 'gatekeeper', slug: 'portal-fixture',
  title: { id: 'Fixture', en: 'Fixture' }, summary: { id: 's', en: 's' },
  maps: ['A05:2025'], levels: ['acolyte'], hints: [],
  check: () => false, mount: () => {},
}));

describe('portal', () => {
  it('GET / lists the registered district and challenge', async () => {
    const res = await request(createApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/gatekeeper/i);
    expect(res.text).toMatch(/PT-01/);
  });

  it('GET /scoreboard shows the session score', async () => {
    const res = await request(createApp()).get('/scoreboard');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Skor|Score/i);
    expect(res.text).toMatch(/\b0\b/); // fresh session: zero score
  });
});
