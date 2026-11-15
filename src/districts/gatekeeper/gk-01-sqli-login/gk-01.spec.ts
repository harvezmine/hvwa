// src/districts/gatekeeper/gk-01-sqli-login/gk-01.spec.ts
import { describe, it, expect } from 'vitest';
import { freshSession } from '../../../../tests/helpers.js';
import './challenge.js'; // registers GK-01 before createApp() inside freshSession

const LAB = '/d/gatekeeper/sqli-login';
const FLAG = /HVWA\{[0-9a-f]{32}\}/;

async function login(level: string, username: string, password: string) {
  const s = await freshSession();
  const res = await s.agent.post(`${LAB}?level=${level}`).type('form').send({ username, password });
  return { ...s, res, flag: FLAG.exec(res.text)?.[0] };
}

// One exploit per exploitable level; each must work at its level and fail at Divine.
const EXPLOITS = {
  acolyte: { username: "templar_admin' --", password: 'x' },          // comment out the password check
  templar: { username: 'templar_admin', password: "' OR role = 'admin" }, // quotes only stripped from username
  inquisitor: { username: 'templar_admin', password: '%' },            // LIKE wildcard
} as const;

describe('GK-01 SQLi login bypass', () => {
  for (const [level, creds] of Object.entries(EXPLOITS)) {
    it(`${level}: exploit reveals a flag credited at ${level}`, async () => {
      const { agent, flag } = await login(level, creds.username, creds.password);
      expect(flag).toBeDefined();
      const submit = await agent.post('/api/submit').send({ challengeId: 'GK-01', submission: flag });
      expect(submit.body).toMatchObject({ solved: true, level });
    });

    it(`divine resists the ${level} exploit`, async () => {
      const { res, flag } = await login('divine', creds.username, creds.password);
      expect(flag).toBeUndefined();
      expect(res.text).toContain('Invalid credentials');
    });
  }

  it('wrong password is rejected at every level', async () => {
    for (const level of ['acolyte', 'templar', 'inquisitor', 'divine']) {
      const { flag } = await login(level, 'templar_admin', 'definitely-wrong');
      expect(flag).toBeUndefined();
    }
  });

  it('GET renders the login form', async () => {
    const { agent } = await freshSession();
    const res = await agent.get(`${LAB}?level=acolyte`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('name="username"');
  });
});
