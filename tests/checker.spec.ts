import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { register, defineChallenge } from '../src/core/registry.js';
import { issueFlag } from '../src/core/flags.js';
import { verifyFlag } from '../src/core/flags.js';

register(defineChallenge({
  id: 'ZZ-01', district: 'test', slug: 't', title:{id:'t',en:'t'}, summary:{id:'',en:''},
  maps:['x'], levels:['acolyte'], hints:[],
  check: (ctx) => verifyFlag('ZZ-01', ctx.sessionId, ctx.submission), mount: () => {},
}));

describe('submit', () => {
  it('accepts the correct per-session flag', async () => {
    const agent = request.agent(createApp());
    await agent.get('/healthz'); // establish session
    const sid = /hvwa_sid=([^;]+)/.exec((await agent.get('/healthz')).headers['set-cookie']?.[0] ?? '')?.[1];
    const flag = issueFlag('ZZ-01', sid!);
    const res = await agent.post('/api/submit').send({ challengeId: 'ZZ-01', level: 'acolyte', submission: flag });
    expect(res.body.solved).toBe(true);
  });
});
