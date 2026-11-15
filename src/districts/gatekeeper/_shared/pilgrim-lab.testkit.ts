// _shared/pilgrim-lab.testkit.ts — the tests and set-up every pilgrim lab (GK-12, 13, 14, 17, 18) shares, for their specs.
// A test kit (see jwt-lab.testkit.ts): `*.testkit.ts` is never collected as a spec and never reaches dist/.
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import type { Express } from 'express';
import { freshSession, describeLabView, setCookieValue, type Agent } from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { PLAYER } from './lab.js';

/** EJS's own escaping of an output value. */
const escapeXML = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/'/g, '&#39;');

/** One player's session on a fresh app, at one level. */
export interface PilgrimCtx { readonly agent: Agent; readonly level: Level; readonly sid: string; readonly app: Express }

export async function newCtx(level: Level): Promise<PilgrimCtx> {
  const { agent, sid, app } = await freshSession();
  return { agent, level, sid, app };
}

const form = { username: PLAYER.username, password: PLAYER.password };

/** The lab's front page and sign-in, as requests: `home(c)`, `login(c)`, `get(c, '/admin')`. */
export function pilgrimClient(path: string) {
  return {
    home: (c: PilgrimCtx) => c.agent.get(`${path}?level=${c.level}`),
    login: (c: PilgrimCtx) => c.agent.post(`${path}?level=${c.level}`).type('form').send(form),
    get: (c: PilgrimCtx, sub: string) => c.agent.get(`${path}${sub}?level=${c.level}`),
    /** The sign-in cookie a login sets, by name. */
    cookie: (res: request.Response, name: string) => setCookieValue(res, name),
  };
}

/** The curl example a lab page must show at one level. */
export interface ExpectedCurl {
  readonly path: string;
  readonly headers?: readonly string[];
  readonly cookies?: readonly string[];
  readonly data?: string;
}

export interface PilgrimLabSpec {
  readonly challenge: { readonly id: string; readonly levels: readonly Level[] };
  /** The lab's base path, e.g. '/d/gatekeeper/idor-profile'. */
  readonly path: string;
  /** The curl line the front page must show at `level`. */
  readonly curl: (level: Level) => ExpectedCurl;
}

/**
 * The shared lab-view checks (account told, no password inputs, forms without action, escaped echo, odd bodies,
 * message classes, upper-case URL) plus the shared curl check: a line a player can use as written, with the full
 * quoted URL and the platform session cookie to copy (never its value).
 */
export function describePilgrimLab(o: PilgrimLabSpec): void {
  describeLabView({
    challenge: o.challenge, path: o.path, account: /pilgrim<\/code> \/ <code>pilgrim/, echoField: 'username', extra: { password: 'x' },
    oddBodies: [{ username: { a: 1 }, password: ['x'] }, { username: [], password: null }, []],
    ok: (agent, level) => agent.post(`${o.path}?level=${level}`).type('form').send(form),
    bad: (agent, level) => agent.post(`${o.path}?level=${level}`).type('form').send({ username: 'pilgrim', password: 'no' }),
  });

  describeCurlExample(o);
}

/** The curl-example check alone, for a lab with its own view checks. */
export function describeCurlExample(o: PilgrimLabSpec): void {
  describe(`${o.challenge.id} curl example`, () => {
    it('the front page gives a curl line that can work: full quoted URL, the headers it needs, the session cookie to copy, never its value', async () => {
      for (const level of LEVELS.filter((l) => o.challenge.levels.includes(l))) {
        const { agent, sid } = await freshSession();
        const res = await agent.get(`${o.path}?level=${level}`);
        const e = o.curl(level);
        const headers = (e.headers ?? []).map((h) => ` -H "${escapeXML(h)}"`).join('');
        const cookies = (e.cookies ?? []).map((c) => `; ${escapeXML(c)}`).join('');
        const data = e.data ? ` -d '${escapeXML(e.data)}'` : '';
        const want = `curl "http://127.0.0.1${o.path}${escapeXML(e.path)}?level=${level}"${headers} -b "hvwa_sid=&lt;copy from devtools&gt;${cookies}"${data}`;
        expect(res.text.replace(/curl "http:\/\/[^/"\s]+/, 'curl "http://127.0.0.1'), level).toContain(want);
        expect(res.text, level).toMatch(/hvwa_sid<\/code> cookie from the devtools storage/);
        expect(res.text, level).not.toContain(sid);
      }
    });
  });
}
