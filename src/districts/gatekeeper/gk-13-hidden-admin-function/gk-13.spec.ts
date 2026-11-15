// src/districts/gatekeeper/gk-13-hidden-admin-function/gk-13.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import type { Express } from 'express';
import {
  freshSession, bare, describeExploitMatrix, describeLabView, FLAG_RE, type Agent,
} from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { GK13 } from './challenge.js'; // registers GK-13 before createApp() inside freshSession
import { labState } from './model.js';

const LAB = '/d/gatekeeper/hidden-admin-function';
interface Ctx { agent: Agent; level: Level; sid: string; app: Express }
type Script = (c: Ctx) => Promise<request.Response>;
type Spec = { paths: Record<string, { get: { deprecated?: boolean } }> };

const home = (c: Ctx) => c.agent.get(`${LAB}?level=${c.level}`);
const login = (c: Ctx) => c.agent.post(`${LAB}?level=${c.level}`).type('form').send({ username: 'pilgrim', password: 'pilgrim' });
const get = (c: Ctx, path: string) => c.agent.get(`${LAB}${path}?level=${c.level}`);

// Acolyte: the function is unlinked, but robots.txt names it, and nothing asks who you are.
const acolyteExploit: Script = async (c) => {
  const robots = await get(c, '/robots.txt');
  const disallow = /Disallow: (\S+)/.exec(robots.text)?.[1] ?? '/admin/';
  return get(c, disallow.endsWith('/') ? `${disallow}export` : disallow);
};
// Templar: the guard matches "/admin" case-sensitively; the router does not care about case.
const templarExploit: Script = async (c) => { await login(c); return get(c, '/Admin/export'); };
// Inquisitor: the served openapi.json lists a deprecated alias that is mounted before the guard.
const inquisitorExploit: Script = async (c) => {
  await login(c);
  const spec = (await get(c, '/openapi.json')).body as Spec;
  const alias = Object.entries(spec.paths ?? {}).find(([, op]) => op.get?.deprecated === true)?.[0];
  return get(c, alias ?? '/legacy/export-all'); // no alias published at Divine: try the old one anyway
};

describeExploitMatrix<Script>({
  challenge: GK13,
  path: LAB,
  send: (agent, level, script, _url, { sid, app }) => script({ agent, level, sid, app }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: /Admin only/,
  legit: [
    { name: 'sign in', input: async (c) => login(c), expect: 'Signed in as pilgrim' },
    { name: 'robots.txt is public', input: async (c) => get(c, '/robots.txt'), expect: 'User-agent' },
    { name: 'openapi.json is public', input: async (c) => get(c, '/openapi.json'), expect: '"openapi"' },
  ],
  malformed: [],
  privileged: {
    name: 'a real admin (test seam) opens the export',
    input: async (c) => { await home(c); labState(c.sid, c.level).user = 'admin'; return get(c, '/admin/export'); },
    expect: /Member export/,
  },
});

describeLabView({
  challenge: GK13, path: LAB, account: /pilgrim<\/code> \/ <code>pilgrim/, echoField: 'username', extra: { password: 'x' },
  oddBodies: [{ username: { a: 1 }, password: ['x'] }, { username: [], password: null }, []],
  ok: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ username: 'pilgrim', password: 'pilgrim' }),
  bad: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ username: 'pilgrim', password: 'no' }),
});

async function ctxFor(level: Level): Promise<Ctx> {
  const { agent, sid, app } = await freshSession();
  return { agent, level, sid, app };
}

describe('GK-13 routing and guards', () => {
  it('acolyte: robots.txt names the function and it opens without signing in', async () => {
    const c = await ctxFor('acolyte');
    expect((await get(c, '/robots.txt')).text).toContain('Disallow: /admin/export');
    expect((await get(c, '/admin/export')).text).toMatch(FLAG_RE);
  });

  it('templar: /admin/export is refused, only the spelling gets through', async () => {
    const c = await ctxFor('templar');
    await login(c);
    expect((await get(c, '/admin/export')).text).toContain('Admin only');
    expect((await get(c, '/Admin/export')).text).toMatch(FLAG_RE);
    expect((await get(c, '/ADMIN/EXPORT')).text).toMatch(FLAG_RE);
  });

  it('inquisitor: case, repeated slashes and encoding no longer slip past the guard', async () => {
    const c = await ctxFor('inquisitor');
    await login(c);
    for (const p of ['/admin/export', '/Admin/export', '/ADMIN/EXPORT', '/%41dmin/export', '//admin/export', '/admin/export/']) {
      const res = await get(c, p);
      expect(res.text, p).not.toMatch(FLAG_RE);
    }
  });

  it('inquisitor: the deprecated alias is published in openapi.json and is the way in', async () => {
    const c = await ctxFor('inquisitor');
    const spec = (await get(c, '/openapi.json')).body as Spec;
    const deprecated = Object.entries(spec.paths).filter(([, op]) => op.get.deprecated).map(([p]) => p);
    expect(deprecated).toHaveLength(1);
    expect((await get(c, deprecated[0])).text).toMatch(FLAG_RE);
  });

  it('only the inquisitor spec publishes a deprecated alias', async () => {
    for (const level of ['acolyte', 'templar', 'divine'] as const) {
      const c = await ctxFor(level);
      const spec = (await get(c, '/openapi.json')).body as Spec;
      expect(Object.values(spec.paths).some((op) => op.get.deprecated), level).toBe(false);
    }
  });

  it('divine: deny by default, every non-public path answers "Admin only", no flag, no 500', async () => {
    const c = await ctxFor('divine');
    await login(c);
    for (const p of ['/admin/export', '/Admin/export', '/ADMIN/EXPORT', '/%41dmin/export', '//admin/export', '/legacy/export-all',
      '/nothing', '/__proto__', '/admin%2Fexport', `/${'x'.repeat(3000)}`]) {
      const res = await get(c, p);
      expect(res.status, p).toBe(200);
      expect(res.text, p).toContain('Admin only');
      expect(res.text, p).not.toMatch(FLAG_RE);
    }
  });

  it('a real admin gets the export at every level without a flag (the flag proves a failure)', async () => {
    for (const level of LEVELS) {
      const c = await ctxFor(level);
      await home(c);
      labState(c.sid, level).user = 'admin';
      const res = await get(c, '/admin/export');
      expect(res.text, level).toContain('Member export');
      expect(res.text, level).not.toMatch(FLAG_RE);
    }
  });

  it('the sign-in is per player and per level', async () => {
    const a = await ctxFor('templar');
    await login(a);
    const b = await ctxFor('templar');
    await home(b);
    expect(labState(b.sid, 'templar').user).toBe('none');
    expect(labState(a.sid, 'templar').user).toBe('pilgrim');
    expect(labState(a.sid, 'divine').user).toBe('none');
  });

  it('a request carrying only the session cookie (not signed in) gets no export and no flag', async () => {
    const c = await ctxFor('templar');
    const res = await bare(c.app, c.sid).get(`${LAB}/admin/export?level=templar`);
    expect(res.text).toContain('Admin only');
    expect(res.text).not.toMatch(FLAG_RE);
  });
});
