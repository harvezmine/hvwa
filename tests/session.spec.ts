import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sessionMiddleware } from '../src/core/session.js';
describe('session', () => {
  it('issues and reuses a session id', async () => {
    const app = express();
    app.use(sessionMiddleware());
    app.get('/me', (req, res) => res.json({ sid: (req as any).sessionId }));
    const agent = request.agent(app);
    const r1 = await agent.get('/me');
    const r2 = await agent.get('/me');
    expect(r1.body.sid).toBe(r2.body.sid);
    expect(r1.headers['set-cookie'][0]).toMatch(/hvwa_sid=/);
  });
});
