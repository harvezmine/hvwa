import { describe, it, expect } from 'vitest';
import { register, defineChallenge } from '../src/core/registry.js';
import { freshSession } from './helpers.js';

register(defineChallenge({
  id: 'HN-01', district: 'test', dir: process.cwd(), slug: 'hint-fixture', title: { id: 't', en: 't' },
  summary: { id: '', en: '' }, maps: [], levels: ['acolyte', 'divine'], mount: () => {},
  hints: [
    { id: 1, text: { id: 'petunjuk satu', en: 'hint one' }, cost: 10 },
    { id: 2, text: { id: 'petunjuk dua', en: 'hint two' }, cost: 25 },
  ],
}));

describe('POST /api/hint', () => {
  it('unlocks a hint and returns { unlocked, tier, text, cost }', async () => {
    const { agent } = await freshSession();
    const res = await agent.post('/api/hint').send({ challengeId: 'HN-01', tier: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      unlocked: true, tier: 2, text: { id: 'petunjuk dua', en: 'hint two' }, cost: 25,
    });
  });

  it('accepts a numeric-string tier (form posts)', async () => {
    const { agent } = await freshSession();
    const res = await agent.post('/api/hint').type('form').send('challengeId=HN-01&tier=1');
    expect(res.body).toMatchObject({ unlocked: true, tier: 1, cost: 10 });
  });

  it('404s an unknown challenge', async () => {
    const { agent } = await freshSession();
    const res = await agent.post('/api/hint').send({ challengeId: 'NOPE-99', tier: 1 });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ unlocked: false, error: 'unknown_challenge' });
  });

  it.each([[0], [4], [1.5], ['x'], ['1x'], [-1], [null], [undefined], [[1]]])(
    '400s an invalid tier %j', async (tier) => {
      const { agent } = await freshSession();
      const res = await agent.post('/api/hint').send({ challengeId: 'HN-01', tier });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ unlocked: false, error: 'invalid_tier' });
    });

  it('404s a well-formed tier the challenge does not define', async () => {
    const { agent } = await freshSession();
    const res = await agent.post('/api/hint').send({ challengeId: 'HN-01', tier: 3 });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ unlocked: false, error: 'unknown_tier' });
  });

  it('unlocking twice is idempotent and the cost is deducted once', async () => {
    const { agent } = await freshSession();
    await agent.post('/api/hint').send({ challengeId: 'HN-01', tier: 1 });
    const again = await agent.post('/api/hint').send({ challengeId: 'HN-01', tier: 1 });
    expect(again.body).toMatchObject({ unlocked: true, tier: 1 });
    const score = /data-testid="score"[^>]*>\s*(-?\d+)/.exec((await agent.get('/scoreboard')).text)?.[1];
    expect(score).toBe('0'); // floored: 0 points - 10 hint cost
  });
});
