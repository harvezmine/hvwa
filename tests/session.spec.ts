import { describe, it, expect } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { sessionMiddleware } from '../src/core/session.js';
import { setCookieHeader, setCookieValue } from './helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function app(opts?: Parameters<typeof sessionMiddleware>[0]) {
  const a = express();
  a.use(cookieParser()); // mirrors createApp()
  a.use(sessionMiddleware(opts));
  a.get('/healthz', (req, res) => { res.json({ sid: req.sessionId }); });
  a.get('/me', (req, res) => { res.json({ sid: req.sessionId }); });
  return a;
}

describe('session', () => {
  it('issues and reuses a session id', async () => {
    const agent = request.agent(app());
    const r1 = await agent.get('/me');
    const r2 = await agent.get('/me');
    expect(r1.body.sid).toMatch(UUID);
    expect(r1.body.sid).toBe(r2.body.sid);
    expect(setCookieValue(r1, 'hvwa_sid')).toBe(r1.body.sid);
  });

  it('hvwa_sid is persistent for one year, httpOnly, SameSite=Lax, path=/', async () => {
    const line = setCookieHeader(await request(app()).get('/me'), 'hvwa_sid') ?? '';
    expect(line).toMatch(/; Max-Age=31536000(;|$)/);
    expect(line).toMatch(/; Expires=[^;]+ GMT/);
    expect(line).toMatch(/; HttpOnly/i);
    expect(line).toMatch(/; SameSite=Lax/i);
    expect(line).toMatch(/; Path=\/(;|$)/);
  });

  it('sets the cookie only when the session is new', async () => {
    const agent = request.agent(app());
    await agent.get('/me');
    const r2 = await agent.get('/me');
    expect(setCookieHeader(r2, 'hvwa_sid')).toBeUndefined();
  });

  it('rejects a non-UUID incoming sid and issues a fresh one', async () => {
    const res = await request(app()).get('/me').set('Cookie', 'hvwa_sid=admin');
    expect(res.body.sid).not.toBe('admin');
    expect(res.body.sid).toMatch(UUID);
    expect(setCookieValue(res, 'hvwa_sid')).toBe(res.body.sid);
  });

  describe('issuance limit (new sessions per rolling minute)', () => {
    it('60 new sessions are issued per minute, the 61st request is a 429 with no cookie; existing sessions are unaffected', async () => {
      let t = 0;
      const a = app({ now: () => t }); // request(a) and request.agent(a) share its one listener (tests/support/supertest.ts)
      const keeper = request.agent(a);
      expect((await keeper.get('/me')).status).toBe(200);
      for (let i = 1; i < 60; i++) expect((await request(a).get('/me')).status, `#${i + 1}`).toBe(200);
      const over = await request(a).get('/me');
      expect(over.status).toBe(429);
      expect(over.text).toMatch(/Too many new sessions/);
      expect(over.headers['set-cookie']).toBeUndefined();
      expect((await keeper.get('/me')).status).toBe(200); // its cookie still works
      t = 59_999;
      expect((await request(a).get('/me')).status).toBe(429);
      t = 60_001; // the window rolls: the first issuance has aged out
      expect((await request(a).get('/me')).status).toBe(200);
    });

    it('the limit is configurable, and /healthz is never limited or counted', async () => {
      const a = app({ maxNewPerMinute: 2, now: () => 0 });
      for (let i = 0; i < 10; i++) expect((await request(a).get('/healthz')).status).toBe(200);
      expect((await request(a).get('/me')).status).toBe(200);
      expect((await request(a).get('/me')).status).toBe(200);
      expect((await request(a).get('/me')).status).toBe(429);
    });

    it('rejects a bad limit', () => {
      for (const maxNewPerMinute of [0, -1, 1.5, Number.NaN]) {
        expect(() => sessionMiddleware({ maxNewPerMinute }), String(maxNewPerMinute)).toThrow(/maxNewPerMinute/);
      }
    });
  });
});
