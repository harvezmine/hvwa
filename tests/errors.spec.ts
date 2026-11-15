import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { errorHandler } from '../src/core/errors.js';
import { register, defineChallenge } from '../src/core/registry.js';
import { TEST_SECRET } from './helpers.js';

const SECRET_DETAIL = 'boom-internal-detail-xyz';

register(defineChallenge({
  id: 'ZZ-03', district: 'test', dir: process.cwd(), slug: 't3', title: { id: 't', en: 't' }, summary: { id: '', en: '' },
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
    const res = await request(createApp({ flagSecret: TEST_SECRET }))
      .post('/api/submit').send({ challengeId: 'ZZ-03', submission: 'x' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
    expectNoLeak(res.text);
  });

  it('malformed JSON is a 400, not a stack trace', async () => {
    const res = await request(createApp({ flagSecret: TEST_SECRET }))
      .post('/api/submit').set('Content-Type', 'application/json').send('{"challengeId":');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'bad_request' });
    expectNoLeak(res.text);
  });
});

describe('404 handling', () => {
  it.each(['get', 'post'] as const)('unknown /api/* (%s) is a JSON 404 not_found', async (method) => {
    const res = await request(createApp())[method]('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it.each(['/nope', '/d/unknown/thing', '/static/missing.css'])('unknown page %s is a minimal HTML 404', async (url) => {
    const res = await request(createApp()).get(url);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Not Found');
    expect(res.text).not.toContain('Cannot GET'); // not Express's default page
  });
});

describe('error labels come from http.STATUS_CODES', () => {
  function withStatus(status: number) {
    const app = express();
    app.get('/api/x', () => { throw Object.assign(new Error(SECRET_DETAIL), { status }); });
    app.get('/page/x', () => { throw Object.assign(new Error(SECRET_DETAIL), { status }); });
    app.use(errorHandler());
    return app;
  }

  it.each([
    [400, 'bad_request', 'Bad Request'],
    [403, 'forbidden', 'Forbidden'],
    [404, 'not_found', 'Not Found'],
    [413, 'payload_too_large', 'Payload Too Large'],
    [415, 'unsupported_media_type', 'Unsupported Media Type'],
  ])('%i → { error: %j } / HTML %j', async (status, code, label) => {
    const api = await request(withStatus(status)).get('/api/x');
    expect(api.status).toBe(status);
    expect(api.body).toEqual({ error: code });
    const page = await request(withStatus(status)).get('/page/x');
    expect(page.status).toBe(status);
    expect(page.text).toContain(label);
    expectNoLeak(api.text + page.text);
  });

  it('server errors stay a generic 500 internal_error', async () => {
    const res = await request(withStatus(503)).get('/api/x');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
  });

  it('an oversized JSON body is a 413 payload_too_large', async () => {
    const res = await request(createApp()).post('/api/submit')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ challengeId: 'X', submission: 'a'.repeat(200 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'payload_too_large' });
  });
});
