import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { register, defineChallenge } from '../src/core/registry.js';
import { issueFlag } from '../src/core/flags.js';
import { freshSession } from './helpers.js';

register(defineChallenge({
  id: 'PT-01', district: 'gatekeeper', slug: 'portal-fixture',
  title: { id: 'Fikstur', en: 'Fixture' }, summary: { id: 's', en: 's' },
  maps: ['A05:2025'], levels: ['acolyte', 'templar', 'divine'], mount: () => {},
  hints: [{ id: 1, text: { id: 'h', en: 'h' }, cost: 30 }],
}));

const testId = (html: string, id: string) =>
  new RegExp(`data-testid="${id}"[^>]*>\\s*([^<]*?)\\s*<`).exec(html)?.[1];

const fresh = () => freshSession();

describe('portal', () => {
  it('GET / lists the registered district and challenge', async () => {
    const res = await request(createApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-district="gatekeeper"');
    expect(res.text).toMatch(/PT-01/);
  });

  it('renders in the remembered language', async () => {
    const { agent } = await fresh();
    expect((await agent.get('/?lang=en')).text).toContain('Fixture');
    const again = await agent.get('/');
    expect(again.text).toContain('District Map');
    expect(again.text).toContain('<html lang="en">');
  });

  it('GET /scoreboard shows zero score and zero solves for a fresh session', async () => {
    const { agent } = await fresh();
    const res = await agent.get('/scoreboard');
    expect(res.status).toBe(200);
    expect(testId(res.text, 'score')).toBe('0');
    expect(testId(res.text, 'solved')).toBe('0');
  });

  it('a real solve via /api/submit changes the displayed score', async () => {
    const { agent, sid } = await fresh();
    const solve = await agent.post('/api/submit')
      .send({ challengeId: 'PT-01', submission: issueFlag('PT-01', sid, 'templar') });
    expect(solve.body).toMatchObject({ solved: true, level: 'templar' });
    const res = await agent.get('/scoreboard');
    expect(testId(res.text, 'score')).toBe('150');
    expect(testId(res.text, 'solved')).toBe('1');
  });

  it('the displayed score reflects unlocked hint costs', async () => {
    const { agent, sid } = await fresh();
    await agent.post('/api/submit')
      .send({ challengeId: 'PT-01', submission: issueFlag('PT-01', sid, 'acolyte') });
    await agent.post('/api/hint').send({ challengeId: 'PT-01', tier: 1 });
    expect(testId((await agent.get('/scoreboard')).text, 'score')).toBe('70');
  });

  it('scores are per session', async () => {
    const a = await fresh();
    await a.agent.post('/api/submit')
      .send({ challengeId: 'PT-01', submission: issueFlag('PT-01', a.sid, 'acolyte') });
    const b = await fresh();
    expect(testId((await b.agent.get('/scoreboard')).text, 'score')).toBe('0');
  });
});
