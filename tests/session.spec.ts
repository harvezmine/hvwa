import { describe, it, expect } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { sessionMiddleware } from '../src/core/session.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function app() {
  const a = express();
  a.use(cookieParser()); // mirrors createApp()
  a.use(sessionMiddleware());
  a.get('/me', (req, res) => res.json({ sid: (req as any).sessionId }));
  return a;
}

describe('session', () => {
  it('issues and reuses a session id', async () => {
    const agent = request.agent(app());
    const r1 = await agent.get('/me');
    const r2 = await agent.get('/me');
    expect(r1.body.sid).toMatch(UUID);
    expect(r1.body.sid).toBe(r2.body.sid);
    expect(r1.headers['set-cookie'][0]).toMatch(/hvwa_sid=/);
  });

  it('sets the cookie only when the session is new', async () => {
    const agent = request.agent(app());
    await agent.get('/me');
    const r2 = await agent.get('/me');
    expect(r2.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a non-UUID incoming sid and issues a fresh one', async () => {
    const res = await request(app()).get('/me').set('Cookie', 'hvwa_sid=admin');
    expect(res.body.sid).not.toBe('admin');
    expect(res.body.sid).toMatch(UUID);
    expect(res.headers['set-cookie'][0]).toContain(`hvwa_sid=${res.body.sid}`);
  });
});
