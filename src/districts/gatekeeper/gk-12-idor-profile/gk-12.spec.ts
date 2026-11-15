// src/districts/gatekeeper/gk-12-idor-profile/gk-12.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import {
  freshSession, describeExploitMatrix, describeLabView, FLAG_RE, type Agent,
} from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { GK12 } from './challenge.js'; // registers GK-12 before createApp() inside freshSession
import { idsFor } from './model.js';

const LAB = '/d/gatekeeper/idor-profile';
interface Ctx { agent: Agent; level: Level }
type Script = (c: Ctx) => Promise<request.Response>;

const home = (c: Ctx) => c.agent.get(`${LAB}?level=${c.level}`);
const login = (c: Ctx) => c.agent.post(`${LAB}?level=${c.level}`).type('form').send({ username: 'pilgrim', password: 'pilgrim' });
const page = (c: Ctx, id: string) => c.agent.get(`${LAB}/profile/${id}?level=${c.level}`);
const api = (c: Ctx, id: string) => c.agent.get(`${LAB}/api/profiles/${id}?level=${c.level}`);
/** The admin's id as a player finds it: from the public directory where it is printed (id 1 below Inquisitor). */
const adminIdFromDirectory = async (c: Ctx): Promise<string> =>
  /citadel_admin: <code>([^<]+)<\/code>/.exec((await home(c)).text)?.[1] ?? 'unknown';
/**
 * Where the exploit is pointed: the admin's REAL id at this level (test seam), so the exploit is also fired at the
 * levels that hide or randomize it (Divine, step-up): they must refuse on ownership, not merely because "1" is no id.
 */
const targetId = async (c: Ctx): Promise<string> => { await home(c); return idsFor(c.level).admin; };

// Acolyte: no ownership check, sequential ids: the admin is 1.
const acolyteExploit: Script = async (c) => { await login(c); return page(c, await targetId(c)); };
// Templar: the HTML page checks ownership, the JSON API does not.
const templarExploit: Script = async (c) => { await login(c); return api(c, await targetId(c)); };
// Inquisitor: UUID from the public directory; the API trusts the X-User-Id header.
const inquisitorExploit: Script = async (c) => {
  await login(c);
  const printed = await adminIdFromDirectory(c);
  const id = printed === 'unknown' ? await targetId(c) : printed;
  return c.agent.get(`${LAB}/api/profiles/${id}?level=${c.level}`).set('X-User-Id', id);
};

describeExploitMatrix<Script>({
  challenge: GK12,
  path: LAB,
  send: (agent, level, script) => script({ agent, level }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: /Profile not found/,
  legit: [
    { name: 'sign in', input: async (c) => login(c), expect: 'Signed in as pilgrim' },
    {
      name: 'own profile page', expect: 'lantern oil',
      input: async (c) => { await login(c); return page(c, (await ownId(c))); },
    },
    {
      name: 'own profile through the API', expect: 'lantern oil',
      input: async (c) => { await login(c); return api(c, (await ownId(c))); },
    },
  ],
  malformed: [],
  privileged: null, // the admin never signs in: the lab has no privileged identity to replay
});

async function ownId(c: Ctx): Promise<string> {
  return /own profile: <code>([^<]+)<\/code>/.exec((await home(c)).text)?.[1] ?? 'unknown';
}

describeLabView({
  challenge: GK12, path: LAB, account: /pilgrim<\/code> \/ <code>pilgrim/, echoField: 'username', extra: { password: 'x' },
  oddBodies: [{ username: { a: 1 }, password: ['x'] }, { username: [], password: null }, []],
  ok: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ username: 'pilgrim', password: 'pilgrim' }),
  bad: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ username: 'pilgrim', password: 'no' }),
});

describe('GK-12 specifics', () => {
  it('id styles: numeric below Inquisitor (admin is 1), UUIDs from Inquisitor up', async () => {
    const { agent, sid } = await freshSession();
    for (const level of LEVELS) await agent.get(`${LAB}?level=${level}`);
    expect(idsFor('acolyte').admin).toBe('1');
    expect(idsFor('templar').admin).toBe('1');
    for (const l of ['inquisitor', 'divine'] as const) expect(idsFor(l).admin).toMatch(/^[0-9a-f-]{36}$/);
    expect(sid).toBeTruthy();
  });

  it('the directory lists ids up to Inquisitor, names only at Divine', async () => {
    for (const level of LEVELS) {
      const { agent } = await freshSession();
      const res = await agent.get(`${LAB}?level=${level}`);
      expect(res.text, level).toContain('citadel_admin');
      if (level === 'divine') expect(res.text).not.toContain(idsFor('divine').admin);
      else expect(res.text, level).toContain(idsFor(level).admin);
    }
  });

  it('templar: the page refuses another user\'s record with a reason, no flag', async () => {
    const { agent } = await freshSession();
    await login({ agent, level: 'templar' });
    const res = await page({ agent, level: 'templar' }, '1');
    expect(res.text).toContain('belongs to another user');
    expect(res.text).not.toMatch(FLAG_RE);
  });

  it('inquisitor: the session itself does not open the admin record without the header', async () => {
    const { agent } = await freshSession();
    const c: Ctx = { agent, level: 'inquisitor' };
    await login(c);
    const res = await api(c, idsFor('inquisitor').admin);
    expect(res.text).not.toMatch(FLAG_RE);
  });

  it('divine ignores X-User-Id and answers unknown and foreign ids identically', async () => {
    const { agent } = await freshSession();
    const c: Ctx = { agent, level: 'divine' };
    await login(c);
    const foreign = await agent.get(`${LAB}/api/profiles/${idsFor('divine').admin}?level=divine`).set('X-User-Id', idsFor('divine').admin);
    const unknown = await api(c, 'does-not-exist');
    expect(foreign.text).toBe(unknown.text);
    expect(foreign.text).not.toMatch(FLAG_RE);
  });

  it('not signed in: every level asks to sign in, no record, no flag', async () => {
    for (const level of LEVELS) {
      const { agent } = await freshSession();
      for (const res of [await page({ agent, level }, '1'), await api({ agent, level }, '1')]) {
        expect(res.text, level).toContain('Sign in first');
        expect(res.text, level).not.toMatch(FLAG_RE);
      }
    }
  });

  it('sign-in state is per player: another session is not signed in', async () => {
    const a = await freshSession();
    await login({ agent: a.agent, level: 'acolyte' });
    const b = await freshSession();
    expect((await page({ agent: b.agent, level: 'acolyte' }, '1')).text).toContain('Sign in first');
  });

  it('strange ids are just "not found", never a 500', async () => {
    const { agent } = await freshSession();
    for (const level of LEVELS) {
      const c: Ctx = { agent, level };
      await login(c);
      for (const id of ['__proto__', 'constructor', '%00', 'x'.repeat(3000), '-1', '1.5']) {
        for (const res of [await page(c, id), await api(c, id)]) {
          expect(res.status, `${level} ${id.slice(0, 10)}`).toBe(200);
          expect(res.text, level).not.toMatch(FLAG_RE);
        }
      }
    }
  });
});
