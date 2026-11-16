// src/districts/forum-of-pilgrims/fp-09-idor-dm/fp-09.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import type { Express } from 'express';
import { FLAG_RE, describeExploitMatrix, describeLabView, freshSession, type Agent } from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import { FP09 } from './challenge.js'; // registers FP-09 before createApp() inside freshSession
import { idsFor } from './model.js';

const LAB = '/d/forum-of-pilgrims/idor-dm';
interface Ctx { readonly agent: Agent; readonly level: Level; readonly sid: string; readonly app: Express }
type Script = (c: Ctx) => Promise<request.Response>;

const form = { username: 'pilgrim', password: 'pilgrim' };
const home = (c: Ctx) => c.agent.get(`${LAB}?level=${c.level}`);
const login = (c: Ctx) => c.agent.post(`${LAB}?level=${c.level}`).type('form').send(form);
const page = (c: Ctx, id: string) => c.agent.get(`${LAB}/dm/${id}?level=${c.level}`);
const api = (c: Ctx, id: string) => c.agent.get(`${LAB}/api/dm/${id}?level=${c.level}`);
async function newCtx(level: Level): Promise<Ctx> {
  const { agent, sid, app } = await freshSession();
  return { agent, level, sid, app };
}
/** The admin's DM as a player finds it: its ref in the public "recent message activity" (printed below Divine). */
const adminRefFromActivity = async (c: Ctx): Promise<string> =>
  /citadel_admin → archivist: <code>([^<]+)<\/code>/.exec((await home(c)).text)?.[1] ?? 'unknown';
/**
 * Where the exploit is pointed: the admin's REAL DM id at this level (test seam), so the exploit is also fired at the
 * levels that hide or randomize it (Divine, step-up): they must refuse on ownership, not because "1" is no id there.
 */
const adminDm = (c: Ctx): string => idsFor(c.sid, c.level).admin;
const ownDm = (c: Ctx): string => idsFor(c.sid, c.level).received;

// Acolyte: no ownership check on either door, sequential ids: the admin's DM is #1.
const acolyteExploit: Script = async (c) => { await login(c); return page(c, adminDm(c)); };
// Templar: the HTML page checks ownership, the JSON API does not.
const templarExploit: Script = async (c) => { await login(c); return api(c, adminDm(c)); };
// Inquisitor: UUID ref from the public activity feed; the API trusts the X-User-Id header.
const inquisitorExploit: Script = async (c) => {
  await login(c);
  const printed = await adminRefFromActivity(c);
  const id = printed === 'unknown' ? adminDm(c) : printed;
  return c.agent.get(`${LAB}/api/dm/${id}?level=${c.level}`).set('X-User-Id', 'citadel_admin');
};

describeExploitMatrix<Script>({
  challenge: FP09,
  path: LAB,
  send: (agent, level, script, _url, { sid, app }) => script({ agent, level, sid, app }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: /Message not found/,
  resistedStatus: 404, // Divine answers a message that is not yours exactly like one that does not exist
  legit: [
    { name: 'sign in', input: async (c) => login(c), expect: 'Signed in as pilgrim' },
    { name: 'own message page', expect: 'lantern oil', input: async (c) => { await login(c); return page(c, ownDm(c)); } },
    { name: 'own message through the API', expect: 'lantern oil', input: async (c) => { await login(c); return api(c, ownDm(c)); } },
  ],
  malformed: [], // no query and no parser: nothing that can raise a database error
  privileged: null, // the admin never signs in: the lab has no privileged identity to replay
});

describeLabView({
  challenge: FP09, path: LAB, account: /pilgrim<\/code> \/ <code>pilgrim/, echoField: 'username', extra: { password: 'x' },
  oddBodies: [{ username: { a: 1 }, password: ['x'] }, { username: [], password: null }, []],
  ok: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send(form),
  bad: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ username: 'pilgrim', password: 'no' }),
});
describeCurlExample({
  challenge: FP09, path: LAB,
  curl: (level) => ({ path: '/api/dm/<message id>', headers: level === 'inquisitor' ? ['X-User-Id: <your username>'] : [] }),
});

describe('FP-09 specifics', () => {
  it('id styles: numeric below Inquisitor (the admin\'s DM is 1), UUIDs from Inquisitor up', async () => {
    const c = await newCtx('acolyte');
    expect(idsFor(c.sid, 'acolyte').admin).toBe('1');
    expect(idsFor(c.sid, 'templar').admin).toBe('1');
    for (const l of ['inquisitor', 'divine'] as const) expect(idsFor(c.sid, l).admin).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('messages are per player: another player\'s UUIDs differ', async () => {
    const a = await newCtx('divine');
    const b = await newCtx('divine');
    expect(idsFor(a.sid, 'divine').admin).not.toBe(idsFor(b.sid, 'divine').admin);
  });

  it('the public activity feed lists refs up to Inquisitor, and no refs at Divine', async () => {
    for (const level of LEVELS) {
      const c = await newCtx(level);
      const res = await home(c);
      expect(res.text, level).toContain('citadel_admin');
      if (level === 'divine') expect(res.text).not.toContain(idsFor(c.sid, 'divine').admin);
      else expect(res.text, level).toContain(idsFor(c.sid, level).admin);
    }
  });

  it('below Divine a message that is not yours is 403 Forbidden (a real refusal), no flag', async () => {
    for (const level of ['templar', 'inquisitor'] as const) {
      const c = await newCtx(level);
      await login(c);
      const res = await page(c, adminDm(c));
      expect(res.status, level).toBe(403);
      expect(res.text, level).toContain('private message');
      expect(res.text, level).not.toMatch(FLAG_RE);
    }
  });

  it('inquisitor: the session itself does not open the admin\'s message through the API (403); the header note is on the page', async () => {
    const c = await newCtx('inquisitor');
    await login(c);
    const res = await api(c, adminDm(c));
    expect(res.status).toBe(403);
    expect(res.text).not.toMatch(FLAG_RE);
    expect((await home(c)).text).toContain('identifies the user to the API with an X-User-Id header');
  });

  it('inquisitor: a header naming YOU does not widen access, and a header naming a stranger opens nothing', async () => {
    const c = await newCtx('inquisitor');
    await login(c);
    expect((await api(c, adminDm(c)).set('X-User-Id', 'pilgrim')).status).toBe(403);
    expect((await api(c, adminDm(c)).set('X-User-Id', 'nobody')).status).toBe(403);
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
    const admin = adminDm(c);
    const foreign = await api(c, admin).set('X-User-Id', 'citadel_admin');
    const unknown = await api(c, 'does-not-exist');
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(foreign.text).toBe(unknown.text);
    expect(foreign.text).not.toMatch(FLAG_RE);
    const pageForeign = await page(c, admin);
    const pageUnknown = await page(c, 'does-not-exist');
    expect(pageForeign.status).toBe(404);
    expect(pageForeign.text).toBe(pageUnknown.text);
  });

  it('your own messages are 200 at every level and show no flag; an unknown id is 404 at every level', async () => {
    for (const level of LEVELS) {
      const c = await newCtx(level);
      await login(c);
      for (const id of [idsFor(c.sid, level).received, idsFor(c.sid, level).sent]) {
        for (const res of [await page(c, id), await api(c, id)]) {
          expect(res.status, level).toBe(200);
          expect(res.text, level).not.toMatch(FLAG_RE);
        }
      }
      expect((await page(c, 'no-such-id')).status, level).toBe(404);
      expect((await api(c, 'no-such-id')).status, level).toBe(404);
    }
  });

  it('the signed-in inbox lists only your own messages, with links built from the lab path', async () => {
    const c = await newCtx('acolyte');
    await login(c);
    const res = await home(c);
    expect(res.text).toContain(`${LAB}/dm/2?level=acolyte`);
    expect(res.text).toContain(`${LAB}/dm/3?level=acolyte`);
    expect(res.text).not.toContain(`${LAB}/dm/1?level=acolyte`);
  });

  it('not signed in: 401 "Sign in first" at every level, no message, no flag', async () => {
    for (const level of LEVELS) {
      const c = await newCtx(level);
      for (const res of [await page(c, adminDm(c)), await api(c, adminDm(c))]) {
        expect(res.status, level).toBe(401);
        expect(res.text, level).toContain('Sign in first');
        expect(res.text, level).not.toMatch(FLAG_RE);
      }
    }
  });

  it('sign-in state is per player and per level', async () => {
    const a = await newCtx('acolyte');
    await login(a);
    const b = await newCtx('acolyte');
    expect((await page(b, '1')).status).toBe(401);
    const other = { ...a, level: 'templar' as const };
    expect((await page(other, '1')).status).toBe(401);
  });

  it('strange ids are 404 (or 200 for your own), never a 500 or a flag', async () => {
    for (const level of LEVELS) {
      const c = await newCtx(level);
      await login(c);
      for (const id of ['__proto__', 'constructor', '%00', 'x'.repeat(3000), '-1', '1.5', '01', '1 ']) {
        for (const res of [await page(c, id), await api(c, id)]) {
          expect(res.status, `${level} ${id.slice(0, 10)}`).toBe(404);
          expect(res.text, level).not.toMatch(FLAG_RE);
        }
      }
    }
  });

  it('a foreign read shows the flag in the page and the JSON, an own read shows none', async () => {
    const c = await newCtx('acolyte');
    await login(c);
    expect((await page(c, adminDm(c))).text).toMatch(FLAG_RE);
    expect((await api(c, adminDm(c))).body.body).toMatch(FLAG_RE);
    expect((await api(c, ownDm(c))).body.body).not.toMatch(FLAG_RE);
  });
});
