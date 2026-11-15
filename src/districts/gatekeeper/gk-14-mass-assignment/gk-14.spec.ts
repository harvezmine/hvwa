// src/districts/gatekeeper/gk-14-mass-assignment/gk-14.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import { describeExploitMatrix, FLAG_RE } from '../../../../tests/helpers.js';
import { LEVELS } from '../../../core/levels.js';
import { describePilgrimLab, newCtx, pilgrimClient, type PilgrimCtx } from '../_shared/pilgrim-lab.testkit.js';
import { GK14 } from './challenge.js'; // registers GK-14 before createApp() inside freshSession
import { labState } from './model.js';

const LAB = '/d/gatekeeper/mass-assignment';
type Ctx = PilgrimCtx;
type Script = (c: Ctx) => Promise<request.Response>;

const { home, login } = pilgrimClient(LAB);
const updateJson = (c: Ctx, body: unknown) => c.agent.post(`${LAB}/profile?level=${c.level}`).send(body as object);
const updateForm = (c: Ctx, body: string) => c.agent.post(`${LAB}/profile?level=${c.level}`).type('form').send(body);
const admin = (c: Ctx) => c.agent.get(`${LAB}/admin?level=${c.level}`);

// Acolyte: every body field is merged into the user record, including role.
const acolyteExploit: Script = async (c) => { await login(c); await updateJson(c, { role: 'admin' }); return admin(c); };
// Templar: the top-level role is stripped, the nested section is deep-merged.
const templarExploit: Script = async (c) => { await login(c); await updateJson(c, { account: { role: 'admin' } }); return admin(c); };
// Inquisitor: an allowlist, but the role follows the (unverified) email domain.
const inquisitorExploit: Script = async (c) => {
  await login(c);
  await updateJson(c, { displayName: 'Pilgrim', email: 'pilgrim@citadel.admin' });
  return admin(c);
};

describeExploitMatrix<Script>({
  challenge: GK14,
  path: LAB,
  send: (agent, level, script, _url, { sid, app }) => script({ agent, level, sid, app }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: /Admin only/,
  resistedStatus: 403,
  legit: [
    { name: 'sign in', input: async (c) => login(c), expect: 'Signed in as pilgrim' },
    {
      name: 'update display name and bio as JSON', expect: 'Profile updated',
      input: async (c) => { await login(c); return updateJson(c, { displayName: 'Brother Lamp', bio: 'Keeper of the east gate' }); },
    },
    {
      name: 'update display name as a form', expect: 'Profile updated',
      input: async (c) => { await login(c); return updateForm(c, 'displayName=Sister+Ash&bio=hello'); },
    },
  ],
  malformed: [],
  privileged: {
    name: 'a real admin (test seam) opens the admin page',
    input: async (c) => { await home(c); labState(c.sid, c.level).user.role = 'admin'; return admin(c); },
    expect: /Citadel admin console/,
  },
});

describePilgrimLab({
  challenge: GK14, path: LAB,
  curl: () => ({ path: '/profile', headers: ['Content-Type: application/json'], data: '{"displayName":"Brother Lamp"}' }),
});

const ctxFor = newCtx;

describe('GK-14 profile updates', () => {
  it('the profile page form (no action) updates the profile through the lab root', async () => {
    const c = await ctxFor('divine');
    await login(c);
    const res = await c.agent.post(`${LAB}?level=divine`).type('form').send({ intent: 'update', displayName: 'Brother Lamp' });
    expect(res.text).toContain('Profile updated');
    expect(res.text).toContain('Brother Lamp');
  });

  it('acolyte: the form spelling works too (role=admin), and so does the json one', async () => {
    const c = await ctxFor('acolyte');
    await login(c);
    await updateForm(c, 'role=admin');
    expect((await admin(c)).text).toMatch(FLAG_RE);
  });

  it('templar: top-level role is stripped (also in a form); account[role] in a form is not', async () => {
    const c = await ctxFor('templar');
    await login(c);
    await updateJson(c, { role: 'admin' });
    expect((await admin(c)).text).toContain('Admin only');
    await updateForm(c, 'role=admin');
    expect((await admin(c)).text).toContain('Admin only');
    await updateForm(c, 'account[role]=admin');
    expect((await admin(c)).text).toMatch(FLAG_RE);
  });

  it('inquisitor: role and nested sections are ignored; only the email domain matters; a normal address keeps user', async () => {
    const c = await ctxFor('inquisitor');
    await login(c);
    await updateJson(c, { role: 'admin', account: { role: 'admin' } });
    expect((await admin(c)).text).toContain('Admin only');
    await updateJson(c, { email: 'pilgrim@example.org' });
    expect((await admin(c)).text).toContain('Admin only');
    await updateJson(c, { email: 'pilgrim@citadel.admin' });
    expect((await admin(c)).text).toMatch(FLAG_RE);
    await updateJson(c, { email: 'pilgrim@example.org' }); // role follows the email back
    expect((await admin(c)).text).toContain('Admin only');
  });

  it('divine: email change stays pending (shown, not applied), role never changes', async () => {
    const c = await ctxFor('divine');
    await login(c);
    const res = await updateJson(c, { email: 'pilgrim@citadel.admin', role: 'admin', account: { role: 'admin' } });
    expect(res.text).toContain('pending verification');
    expect(res.text).toContain('pilgrim@citadel.admin');
    const user = labState(c.sid, 'divine').user;
    expect(user.email).toBe('pilgrim@citadel.example');
    expect(user.pendingEmail).toBe('pilgrim@citadel.admin');
    expect(user.role).toBe('user');
    expect((await admin(c)).text).toContain('Admin only');
  });

  it('not signed in: no update, no change, no flag', async () => {
    for (const level of LEVELS) {
      const c = await ctxFor(level);
      const res = await updateJson(c, { role: 'admin', account: { role: 'admin' }, email: 'x@citadel.admin' });
      expect(res.status, level).toBe(401);
      expect(res.text, level).toContain('Sign in first');
      const adm = await admin(c);
      expect(adm.status, level).toBe(403);
      expect(adm.text, level).toContain('Admin only');
      expect(labState(c.sid, level).user.role, level).toBe('user');
    }
  });

  it('prototype pollution is a different lab: dangerous keys are ignored at every level', async () => {
    const payloads = [
      '{"__proto__":{"role":"admin","polluted14":"yes"}}',
      '{"constructor":{"prototype":{"polluted14":"yes"}}}',
      '{"account":{"__proto__":{"polluted14":"yes"}}}',
      '{"a":{"b":{"constructor":{"prototype":{"polluted14":"yes"}}}}}',
    ];
    for (const level of LEVELS) {
      const c = await ctxFor(level);
      await login(c);
      for (const p of payloads) {
        const res = await c.agent.post(`${LAB}/profile?level=${level}`).type('json').send(p);
        expect(res.status, `${level} ${p}`).toBe(200);
        expect(res.text, level).not.toMatch(FLAG_RE);
      }
      expect(({} as Record<string, unknown>).polluted14, level).toBeUndefined();
      expect(({} as Record<string, unknown>).role, level).toBeUndefined();
      expect(Object.getPrototypeOf(labState(c.sid, level).user), level).toBe(Object.prototype);
      expect((await admin(c)).text, level).toContain('Admin only');
    }
  });

  it('odd bodies (arrays, scalars, deep nesting, huge key counts) never 500 and never grant admin', async () => {
    for (const level of LEVELS) {
      const c = await ctxFor(level);
      await login(c);
      const deep: Record<string, unknown> = {};
      let cur = deep;
      for (let i = 0; i < 200; i++) { const n: Record<string, unknown> = {}; cur.n = n; cur = n; }
      const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
      for (const body of [[], [1, 2], {}, deep, many, { displayName: { x: 1 }, bio: ['a'], email: 5 }]) {
        const res = await c.agent.post(`${LAB}/profile?level=${level}`).type('json').send(JSON.stringify(body));
        expect(res.status, `${level} ${JSON.stringify(body).slice(0, 30)}`).toBe(200);
        expect(res.text, level).not.toMatch(FLAG_RE);
      }
      expect((await admin(c)).text, level).toContain('Admin only');
    }
  });

  it('state is per player and per level: one player\'s promotion changes nobody else', async () => {
    const a = await ctxFor('acolyte');
    await acolyteExploit(a);
    const b = await ctxFor('acolyte');
    await login(b);
    expect((await admin(b)).text).toContain('Admin only');
    expect(labState(a.sid, 'templar').user.role).toBe('user');
  });

  it('the record is bounded: many distinct keys stop at 60 fields, long values are cut', async () => {
    for (const level of ['acolyte', 'templar'] as const) {
      const c = await ctxFor(level);
      await login(c);
      for (let r = 0; r < 3; r++) {
        const body = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${r}_${i}`, 'v']));
        expect((await updateJson(c, body)).status, level).toBe(200);
      }
      expect(Object.keys(labState(c.sid, level).user).length, level).toBeLessThanOrEqual(60);
      await updateJson(c, { bio: 'b'.repeat(2000), displayName: 'd'.repeat(2000) });
      expect(String(labState(c.sid, level).user.bio).length, level).toBe(500);
    }
    for (const level of ['inquisitor', 'divine'] as const) {
      const c = await ctxFor(level);
      await login(c);
      await updateJson(c, { bio: 'b'.repeat(2000), displayName: 'd'.repeat(2000) });
      const user = labState(c.sid, level).user;
      expect(String(user.bio).length, level).toBe(500);
      expect(String(user.displayName).length, level).toBe(80);
    }
  });

  it('an invalid email is refused (422) where emails are read, and nothing changes', async () => {
    for (const level of ['inquisitor', 'divine'] as const) {
      const c = await ctxFor(level);
      await login(c);
      const res = await updateJson(c, { email: 'not an email' });
      expect(res.status, level).toBe(422);
      expect(labState(c.sid, level).user.email, level).toBe('pilgrim@citadel.example');
    }
  });

  it('inquisitor: the page names the staff domain (the breadcrumb); the other levels do not', async () => {
    const c = await ctxFor('inquisitor');
    expect((await home(c)).text).toContain('@citadel.admin');
    for (const level of ['acolyte', 'templar', 'divine'] as const) {
      expect((await home(await ctxFor(level))).text, level).not.toContain('@citadel.admin');
    }
  });
});
