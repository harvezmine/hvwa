import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { register, defineChallenge, type Level } from '../src/core/registry.js';
import { issueFlag, verifyFlag } from '../src/core/flags.js';

// All four levels, default check (level-bound flag verification).
register(defineChallenge({
  id: 'ZZ-01', district: 'test', slug: 't', title: { id: 't', en: 't' }, summary: { id: '', en: '' },
  maps: ['x'], levels: ['acolyte', 'templar', 'inquisitor', 'divine'], hints: [], mount: () => {},
}));

// Only Acolyte + Divine implemented.
register(defineChallenge({
  id: 'ZZ-02', district: 'test', slug: 't2', title: { id: 't', en: 't' }, summary: { id: '', en: '' },
  maps: ['x'], levels: ['acolyte', 'divine'], hints: [],
  check: (ctx) => verifyFlag('ZZ-02', ctx.sessionId, ctx.level, ctx.submission), mount: () => {},
}));

// Records the order in which levels are tried.
const tried: Level[] = [];
register(defineChallenge({
  id: 'ZZ-04', district: 'test', slug: 't4', title: { id: 't', en: 't' }, summary: { id: '', en: '' },
  maps: ['x'], levels: ['divine', 'acolyte', 'inquisitor', 'templar'], hints: [],
  check: (ctx) => { tried.push(ctx.level); return false; }, mount: () => {},
}));

async function fresh() {
  const agent = request.agent(createApp({ flagSecret: 'test-secret' }));
  // The FIRST response of a fresh agent establishes the session and carries the sid.
  const res = await agent.get('/healthz');
  const sid = /hvwa_sid=([^;]+)/.exec(res.headers['set-cookie']?.[0] ?? '')![1];
  return { agent, sid };
}

describe('submit', () => {
  it('accepts the correct per-session acolyte flag and records acolyte points', async () => {
    const { agent, sid } = await fresh();
    const res = await agent.post('/api/submit')
      .send({ challengeId: 'ZZ-01', submission: issueFlag('ZZ-01', sid, 'acolyte') });
    expect(res.body).toEqual({
      solved: true, level: 'acolyte', points: 100, best: { level: 'acolyte', points: 100 },
    });
  });

  it('credits templar and inquisitor flags at their own level', async () => {
    const { agent, sid } = await fresh();
    const t = await agent.post('/api/submit')
      .send({ challengeId: 'ZZ-01', submission: issueFlag('ZZ-01', sid, 'templar') });
    expect(t.body).toEqual({
      solved: true, level: 'templar', points: 150, best: { level: 'templar', points: 150 },
    });
    const i = await agent.post('/api/submit')
      .send({ challengeId: 'ZZ-01', submission: issueFlag('ZZ-01', sid, 'inquisitor') });
    expect(i.body).toEqual({
      solved: true, level: 'inquisitor', points: 200, best: { level: 'inquisitor', points: 200 },
    });
  });

  it('a lower re-solve reports the submitted level but keeps the stored best', async () => {
    const { agent, sid } = await fresh();
    await agent.post('/api/submit')
      .send({ challengeId: 'ZZ-01', submission: issueFlag('ZZ-01', sid, 'inquisitor') });
    const res = await agent.post('/api/submit')
      .send({ challengeId: 'ZZ-01', submission: issueFlag('ZZ-01', sid, 'acolyte') });
    expect(res.body).toEqual({
      solved: true, level: 'acolyte', points: 100, best: { level: 'inquisitor', points: 200 },
    });
  });

  it('ignores a client-supplied level: an acolyte flag is never credited as inquisitor', async () => {
    const { agent, sid } = await fresh();
    const res = await agent.post('/api/submit').send({
      challengeId: 'ZZ-01', level: 'inquisitor', submission: issueFlag('ZZ-01', sid, 'acolyte'),
    });
    expect(res.body).toEqual({
      solved: true, level: 'acolyte', points: 100, best: { level: 'acolyte', points: 100 },
    });
  });

  it('does not credit a flag for a level the challenge does not implement', async () => {
    const { agent, sid } = await fresh();
    const res = await agent.post('/api/submit')
      .send({ challengeId: 'ZZ-02', submission: issueFlag('ZZ-02', sid, 'inquisitor') });
    expect(res.body).toEqual({ solved: false });
  });

  it('rejects wrong and cross-session flags', async () => {
    const { agent } = await fresh();
    const wrong = await agent.post('/api/submit').send({ challengeId: 'ZZ-01', submission: 'HVWA{nope}' });
    expect(wrong.body).toEqual({ solved: false });
    const other = await agent.post('/api/submit')
      .send({ challengeId: 'ZZ-01', submission: issueFlag('ZZ-01', 'someone-else', 'acolyte') });
    expect(other.body).toEqual({ solved: false });
  });

  it('tries implemented non-Divine levels, highest first', async () => {
    const { agent } = await fresh();
    tried.length = 0;
    await agent.post('/api/submit').send({ challengeId: 'ZZ-04', submission: 'x' });
    expect(tried).toEqual(['inquisitor', 'templar', 'acolyte']);
  });

  it('keeps one flag secret across createApp() calls that pass no flagSecret', async () => {
    const first = request.agent(createApp());
    const r = await first.get('/healthz');
    const sid = /hvwa_sid=([^;]+)/.exec(r.headers['set-cookie']?.[0] ?? '')![1];
    const flag = issueFlag('ZZ-01', sid, 'acolyte'); // issued while using the first app
    const second = createApp(); // must not rotate the process-wide secret
    const res = await request(second).post('/api/submit')
      .set('Cookie', `hvwa_sid=${sid}`).send({ challengeId: 'ZZ-01', submission: flag });
    expect(res.body).toMatchObject({ solved: true, level: 'acolyte' });
  });

  it('404s an unknown challenge', async () => {
    const { agent } = await fresh();
    const res = await agent.post('/api/submit').send({ challengeId: 'NOPE-1', submission: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.solved).toBe(false);
  });
});
