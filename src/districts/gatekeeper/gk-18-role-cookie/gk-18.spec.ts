// src/districts/gatekeeper/gk-18-role-cookie/gk-18.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import {
  bare, describeExploitMatrix, FLAG_RE, setCookieHeader, setCookieValue,
} from '../../../../tests/helpers.js';
import { LEVELS } from '../../../core/levels.js';
import { describePilgrimLab, newCtx, pilgrimClient, type PilgrimCtx } from '../_shared/pilgrim-lab.testkit.js';
import { GK18 } from './challenge.js'; // registers GK-18 before createApp() inside freshSession
import { cookieName, labState } from './model.js';

const LAB = '/d/gatekeeper/role-cookie';
type Ctx = PilgrimCtx;
type Script = (c: Ctx) => Promise<request.Response>;

const { home, login } = pilgrimClient(LAB);
/** The admin page with ONLY this lab cookie (no jar): exactly what editing the cookie in devtools or `curl -b` does. */
const adminWith = (c: Ctx, value: string) => bare(c.app, c.sid, `${cookieName(c.level)}=${value}`).get(`${LAB}/admin?level=${c.level}`);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const issued = async (c: Ctx) => setCookieValue(await login(c), cookieName(c.level)) ?? '';

// Acolyte: the cookie IS the role.
const acolyteExploit: Script = async (c) => adminWith(c, 'admin');
// Templar: base64(JSON { user, role }), unsigned.
const templarExploit: Script = async (c) => adminWith(c, b64({ user: 'pilgrim', role: 'admin' }));
// Inquisitor: keep the issued signature, change the role in the payload (the HMAC covers only user).
const inquisitorExploit: Script = async (c) => {
  const [payload, sig] = (await issued(c)).split('.');
  let body: Record<string, unknown> = { user: 'pilgrim' };
  try { body = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<string, unknown>; } catch { /* an opaque id: forge anyway */ }
  return adminWith(c, `${b64({ ...body, role: 'admin' })}.${sig}`);
};

describeExploitMatrix<Script>({
  challenge: GK18,
  path: LAB,
  send: (agent, level, script, _url, { sid, app }) => script({ agent, level, sid, app }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: /Admin only/,
  resistedStatus: 403,
  legit: [
    { name: 'sign in', input: async (c) => login(c), expect: 'Signed in as pilgrim' },
    {
      name: 'the front page knows the signed-in user', expect: 'role: user',
      input: async (c) => { await login(c); return home(c); },
    },
  ],
  malformed: [],
  privileged: {
    name: 'a real admin session (test seam) opens the admin page',
    input: async (c) => {
      await home(c);
      const sid = 'a'.repeat(64);
      labState(c.sid, c.level).sessions.set(sid, { user: 'citadel_admin', role: 'admin' });
      return adminWith(c, sid);
    },
    expect: /Citadel admin console/,
  },
});

describePilgrimLab({
  challenge: GK18, path: LAB,
  curl: (level) => ({ path: '/admin', cookies: [`${cookieName(level)}=<cookie value>`] }),
});

const ctxFor = newCtx;

describe('GK-18 cookies', () => {
  it('pilgrim opens the admin page with their own cookie: 403 "Admin only" at every level, no flag', async () => {
    for (const level of LEVELS) {
      const c = await ctxFor(level);
      await login(c);
      const res = await c.agent.get(`${LAB}/admin?level=${level}`);
      expect(res.status, level).toBe(403);
      expect(res.text, level).toContain('Admin only');
      expect(res.text, level).not.toMatch(FLAG_RE);
    }
  });

  it('each level sets its own cookie, Path = the lab, never an hvwa_ name; only Divine\'s is HttpOnly', async () => {
    for (const level of LEVELS) {
      const c = await ctxFor(level);
      const line = setCookieHeader(await login(c), `citadel_role_${level}`);
      expect(line, level).toBeDefined();
      expect(line, level).toContain(`Path=${LAB}`);
      expect(line, level).not.toMatch(/^hvwa_/);
      if (level === 'divine') expect(line).toMatch(/HttpOnly/i); else expect(line, level).not.toMatch(/HttpOnly/i);
    }
  });

  it('acolyte: the cookie value is the plain role', async () => {
    const c = await ctxFor('acolyte');
    expect(await issued(c)).toBe('user');
  });

  it('templar: base64 JSON with user and role, no signature', async () => {
    const c = await ctxFor('templar');
    const v = await issued(c);
    expect(v).not.toContain('.');
    expect(JSON.parse(Buffer.from(v, 'base64url').toString('utf8'))).toEqual({ user: 'pilgrim', role: 'user' });
  });

  it('inquisitor: payload.signature; a changed user breaks the signature, a changed role does not', async () => {
    const c = await ctxFor('inquisitor');
    const [payload, sig] = (await issued(c)).split('.');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { user: string; role: string };
    expect(body).toEqual({ user: 'pilgrim', role: 'user' });
    expect((await adminWith(c, `${b64({ user: 'citadel_admin', role: 'admin' })}.${sig}`)).text).toContain('Admin only');
    expect((await adminWith(c, `${b64({ user: 'pilgrim', role: 'admin' })}.${sig}`)).text).toMatch(FLAG_RE);
    expect((await adminWith(c, `${b64({ user: 'pilgrim', role: 'admin' })}.${'0'.repeat(64)}`)).text).toContain('Admin only');
    expect((await adminWith(c, b64({ user: 'pilgrim', role: 'admin' }))).text).toContain('Admin only');
  });

  it('divine: an opaque 64-hex session id, looked up on the server; role edits and older formats are worthless', async () => {
    const c = await ctxFor('divine');
    const v = await issued(c);
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(labState(c.sid, 'divine').sessions.get(v)).toEqual({ user: 'pilgrim', role: 'user' });
    for (const forged of ['admin', b64({ user: 'pilgrim', role: 'admin' }), `${b64({ user: 'pilgrim', role: 'admin' })}.${'0'.repeat(64)}`, `${v}admin`]) {
      const res = await adminWith(c, forged);
      expect(res.text, forged.slice(0, 20)).toContain('Admin only');
      expect(res.text).not.toMatch(FLAG_RE);
    }
  });

  it('divine: another player\'s session id is worthless in my lab, and new sign-ins mint new ids', async () => {
    const a = await ctxFor('divine');
    const b = await ctxFor('divine');
    const idA = await issued(a);
    const idA2 = await issued(a);
    expect(idA2).not.toBe(idA);
    await home(b);
    expect(labState(b.sid, 'divine').sessions.has(idA)).toBe(false);
    labState(a.sid, 'divine').sessions.set('b'.repeat(64), { user: 'citadel_admin', role: 'admin' });
    expect((await adminWith(b, 'b'.repeat(64))).text).toContain('Admin only');
  });

  it('the session store is bounded', async () => {
    const c = await ctxFor('divine');
    for (let i = 0; i < 40; i++) await login(c);
    expect(labState(c.sid, 'divine').sessions.size).toBeLessThanOrEqual(20);
  });

  it('odd cookies are simply "Admin only", never a 500 or a flag, at every level', async () => {
    const weird = ['', 'null', '__proto__', 'constructor', '%00', 'x'.repeat(5000), 'j%3A%7B%22role%22%3A%22admin%22%7D',
      '.', '..', 'a.b.c', b64([1, 2]), b64('admin'), b64({ role: { x: 1 } })];
    for (const level of LEVELS) {
      const c = await ctxFor(level);
      await home(c);
      for (const v of weird) {
        const res = await adminWith(c, v);
        expect(res.status, `${level} ${v.slice(0, 12)}`).toBe(403);
        expect(res.text, `${level} ${v.slice(0, 12)}`).not.toMatch(FLAG_RE);
      }
    }
  });

  it('a valid-looking payload with a missing or empty signature is refused where signatures exist', async () => {
    for (const level of ['inquisitor', 'divine'] as const) {
      const c = await ctxFor(level);
      await home(c);
      for (const v of [`${b64({ user: 'pilgrim', role: 'admin' })}.`, `${b64({ user: 'pilgrim', role: 'admin' })}.x`, `.${'0'.repeat(64)}`]) {
        const res = await adminWith(c, v);
        expect(res.text, `${level} ${v.slice(0, 12)}`).toContain('Admin only');
      }
    }
  });

  it('no cookie: the front page and admin page change nothing and show no flag', async () => {
    for (const level of LEVELS) {
      const c = await ctxFor(level);
      const front = await bare(c.app, c.sid).get(`${LAB}?level=${level}`);
      const adm = await bare(c.app, c.sid).get(`${LAB}/admin?level=${level}`);
      expect(front.status).toBe(200);
      expect(adm.status, level).toBe(403);
      expect(adm.text, level).toContain('Admin only');
      expect(adm.text, level).not.toMatch(FLAG_RE);
      expect(front.headers['set-cookie']?.toString() ?? '', level).not.toContain('citadel_role_');
    }
    const c = await ctxFor('divine');
    await bare(c.app, c.sid).get(`${LAB}/admin?level=divine`);
    expect(labState(c.sid, 'divine').sessions.size).toBe(0);
  });
});
