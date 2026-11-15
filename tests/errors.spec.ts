import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { errorHandler } from '../src/core/errors.js';
import { register, defineChallenge } from '../src/core/registry.js';

const SECRET_DETAIL = 'boom-internal-detail-xyz';

register(defineChallenge({
  id: 'ZZ-03', district: 'test', slug: 't3', title: { id: 't', en: 't' }, summary: { id: '', en: '' },
  maps: ['x'], levels: ['acolyte'], hints: [],
  check: () => { throw new Error(SECRET_DETAIL); }, mount: () => {},
}));

function bare() {
  const app = express();
  app.get('/api/boom', () => { throw new Error(SECRET_DETAIL); });
  app.get('/api/async-boom', async () => { throw new Error(SECRET_DETAIL); });
  app.get('/page/boom', () => { throw new Error(SECRET_DETAIL); });
  app.use(errorHandler());
  return app;
}

function expectNoLeak(text: string) {
  expect(text).not.toContain(SECRET_DETAIL);
  expect(text).not.toMatch(/\n\s+at /); // stack frame lines
  expect(text).not.toMatch(/\.ts:\d+/);
}

describe('error handler', () => {
  it('answers /api/* errors with a 500 JSON body and no stack', async () => {
    const res = await request(bare()).get('/api/boom');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'internal_error' });
    expectNoLeak(res.text);
  });

  it('handles async rejections the same way', async () => {
    const res = await request(bare()).get('/api/async-boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
  });

  it('answers non-API errors with a minimal HTML 500 page and no stack', async () => {
    const res = await request(bare()).get('/page/boom');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expectNoLeak(res.text);
  });

  it('a throwing check() yields 500 JSON without stack text', async () => {
    const res = await request(createApp({ flagSecret: 'test-secret' }))
      .post('/api/submit').send({ challengeId: 'ZZ-03', submission: 'x' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
    expectNoLeak(res.text);
  });

  it('malformed JSON is a 400, not a stack trace', async () => {
    const res = await request(createApp({ flagSecret: 'test-secret' }))
      .post('/api/submit').set('Content-Type', 'application/json').send('{"challengeId":');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'bad_request' });
    expectNoLeak(res.text);
  });
});
